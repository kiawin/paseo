import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,128}$/)
  .refine(
    (value) => !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value),
    "Reserved recording identifier",
  );
const metadataSchema = z
  .object({
    recordingId: identifier,
    schemaVersion: z.number().int().positive().optional(),
    workspaceId: z.string().min(1).max(2048),
    startedAt: z.number().finite().nonnegative(),
    endedAt: z.number().finite().nonnegative().optional(),
    status: z.enum(["recording", "complete", "interrupted"]),
    title: z.string().max(1024).optional(),
    captureErrors: z.array(z.string().max(1024)).max(100).optional(),
    audioRequested: z.boolean().optional(),
    audioStatus: z.enum(["starting", "captured", "unavailable", "disabled"]).optional(),
    audioReason: z.string().max(128).optional(),
    recoveryWarnings: z.array(z.string().max(1024)).max(10).optional(),
  })
  .passthrough();
const shareAuditSchema = z
  .array(
    z.object({
      recordingId: identifier,
      serverId: z.string().min(1).max(256),
      agentId: z.string().min(1).max(256),
      shareId: z.string().uuid(),
      time: z.number().finite().nonnegative(),
      completeness: z.object({
        complete: z.boolean(),
        reasons: z.array(z.string().max(1024)).max(100),
      }),
      manifestPath: z.string().max(4096),
    }),
  )
  .max(1000);
const eventSchema = z
  .object({
    recordingId: identifier,
    memberId: z.string().min(1).max(256),
    webContentsId: z.number().int().nonnegative(),
    frameId: z.string().max(256).optional(),
    documentId: z.string().max(256).optional(),
    frameAttribution: z.enum(["identified", "unattributed"]),
    timelineMs: z.number().finite().nonnegative().optional(),
    kind: z.enum(["interaction", "network", "media", "gap"]),
    payload: z
      .unknown()
      .refine((value) => value !== undefined, "Recording event payload is required"),
  })
  .passthrough();
const segmentSchema = z
  .object({
    streamId: identifier,
    segmentId: identifier,
    startMs: z.number().finite().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
    mimeType: z.string().min(1).max(256),
    track: z.enum(["video", "audio", "combined"]).optional(),
    codec: z.string().min(1).max(256).optional(),
    generationId: identifier.optional(),
    sequence: z.number().int().nonnegative().optional(),
  })
  .strict();
const storedSegmentSchema = segmentSchema.extend({
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RecordingMetadata = z.infer<typeof metadataSchema>;
export type StoredRecordingEvent = z.infer<typeof eventSchema>;
export type MediaSegmentInfo = z.infer<typeof segmentSchema>;
export type MediaSegment = MediaSegmentInfo & { bytes: Uint8Array };
export interface IncompleteMediaSegment {
  streamId: string | null;
  segmentId: string | null;
  reason: string;
}
export interface MediaSegmentListing {
  segments: MediaSegmentInfo[];
  incomplete: IncompleteMediaSegment[];
}
interface Options {
  maxMediaSegmentBytes?: number;
  maxEventBytes?: number;
  maxEventReadBytes?: number;
  maxQueuedBytes?: number;
  maxQueuedOperations?: number;
  maxStorageBytes?: number;
}
const noFollow = fsConstants.O_NOFOLLOW ?? 0;
function isCorruptMetadata(error: unknown): boolean {
  return (
    (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") ||
    error instanceof SyntaxError ||
    error instanceof z.ZodError
  );
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function survivingBytes(paths: string[]): Promise<number> {
  let total = 0;
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) total += info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total;
}
const sharedQueues = new Map<string, Promise<void>>();
const sharedQueueCounts = new Map<string, number>();
interface QuotaState {
  used: number;
  reserved: number;
  ready: Promise<void>;
}
const sharedQuotaStates = new Map<string, QuotaState>();
async function measureTree(path: string): Promise<number> {
  let bytes = 0;
  const directories = [path];
  let entriesSeen = 0;
  while (directories.length) {
    const current = directories.pop()!;
    const entries = await opendir(current);
    for await (const entry of entries) {
      if (++entriesSeen > 1_000_000) throw new Error("Recording storage scan limit exceeded");
      if (entry.isSymbolicLink()) continue;
      const child = join(current, entry.name);
      if (entry.isDirectory()) directories.push(child);
      else if (entry.isFile()) {
        const stat = await lstat(child);
        if (stat.isFile() && !stat.isSymbolicLink()) bytes += stat.size;
      }
    }
  }
  return bytes;
}
const sharedQueuedBytes = new Map<string, number>();
const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const appendRollbackFailure = (error: unknown, rollbackError: unknown): Error =>
  new AggregateError([error, rollbackError], "Recording event append and rollback failed", {
    cause: error,
  });
function assertJsonValue(value: unknown, maxBytes: number): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  function countString(text: string): void {
    stringBytes += Buffer.byteLength(text);
    if (stringBytes > maxBytes) throw new Error("Recording event exceeds size limit");
  }
  function visitArray(entry: unknown[], keys: PropertyKey[], depth: number): void {
    if (keys.length !== entry.length + 1)
      throw new Error("Recording event contains non-JSON array properties");
    for (let index = 0; index < entry.length; index += 1) {
      if (!Object.hasOwn(entry, index)) throw new Error("Recording event contains an array hole");
      const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new Error("Recording event contains a non-JSON array entry");
      visit(descriptor.value, depth + 1);
    }
  }
  function visitObject(entry: object, keys: PropertyKey[], depth: number): void {
    for (const name of keys) {
      const key = name as string;
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new Error("Recording event contains a non-JSON property");
      countString(key);
      visit(descriptor.value, depth + 1);
    }
  }
  function visitContainer(entry: object, depth: number): void {
    if (ancestors.has(entry)) throw new Error("Recording event contains a cycle");
    const prototype = Object.getPrototypeOf(entry);
    if (
      Array.isArray(entry)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new Error("Recording event contains a non-JSON object");
    const keys = Reflect.ownKeys(entry);
    if (keys.length > 100_001) throw new Error("Recording event JSON structure exceeds limit");
    if (keys.some((key) => typeof key !== "string"))
      throw new Error("Recording event contains symbol keys");
    ancestors.add(entry);
    if (Array.isArray(entry)) visitArray(entry, keys, depth);
    else visitObject(entry, keys, depth);
    ancestors.delete(entry);
  }
  function visit(entry: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64)
      throw new Error("Recording event JSON structure exceeds limit");
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "string") {
      countString(entry);
      return;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || Object.is(entry, -0))
        throw new Error("Recording event contains a non-JSON number");
      return;
    }
    if (typeof entry !== "object") throw new Error("Recording event contains a non-JSON value");
    visitContainer(entry, depth);
  }
  visit(value, 0);
}

// Store instances share per-recording queues. Electron's single-instance lock
// prevents two desktop processes from writing the same user-data root.
export class BrowserRecordingStore {
  private readonly root: string;
  private readonly queues = sharedQueues;
  private readonly maxMediaSegmentBytes: number;
  private readonly maxEventBytes: number;
  private readonly maxEventReadBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly maxQueuedOperations: number;
  private readonly maxStorageBytes: number;
  private readonly queuedOperations = sharedQueueCounts;
  private readonly recoveryOverrides = new Map<string, RecordingMetadata>();
  constructor(root: string, options: Options = {}) {
    if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root)
      throw new Error("Recording root must be an absolute non-root directory");
    this.root = resolve(root);
    this.maxMediaSegmentBytes = options.maxMediaSegmentBytes ?? 64 * 1024 * 1024;
    this.maxEventBytes = options.maxEventBytes ?? 8 * 1024 * 1024;
    this.maxEventReadBytes = options.maxEventReadBytes ?? 64 * 1024 * 1024;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 128 * 1024 * 1024;
    this.maxQueuedOperations = options.maxQueuedOperations ?? 1024;
    this.maxStorageBytes = options.maxStorageBytes ?? 4 * 1024 * 1024 * 1024;
    for (const limit of [
      this.maxMediaSegmentBytes,
      this.maxEventBytes,
      this.maxEventReadBytes,
      this.maxQueuedBytes,
      this.maxQueuedOperations,
      this.maxStorageBytes,
    ]) {
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new Error("Invalid recording storage limit");
    }
    if (
      this.maxMediaSegmentBytes > 256 * 1024 * 1024 ||
      this.maxEventBytes > 16 * 1024 * 1024 ||
      this.maxEventReadBytes > 256 * 1024 * 1024 ||
      this.maxQueuedBytes > 256 * 1024 * 1024 ||
      this.maxQueuedOperations > 1024
    )
      throw new Error("Recording storage limit is too large");
  }
  private async quotaState(): Promise<QuotaState> {
    const existing = sharedQuotaStates.get(this.root);
    if (existing) {
      await existing.ready;
      return existing;
    }
    await this.ensureDirectory(this.root);
    let state = sharedQuotaStates.get(this.root);
    if (!state) {
      state = { used: 0, reserved: 0, ready: Promise.resolve() };
      const current = state;
      state.ready = measureTree(this.root).then((bytes) => {
        current.used = bytes;
        return undefined;
      });
      sharedQuotaStates.set(this.root, state);
      void state.ready.catch(() => {
        if (sharedQuotaStates.get(this.root) === current) sharedQuotaStates.delete(this.root);
      });
    }
    await state.ready;
    return state;
  }
  private async reserveStorage(
    bytes: number,
    allowOverQuota = false,
  ): Promise<(delta?: number) => void> {
    const state = await this.quotaState();
    if (!allowOverQuota && state.used + state.reserved + bytes > this.maxStorageBytes)
      throw new Error("Recording storage quota exceeded");
    state.reserved += bytes;
    let released = false;
    return (delta = bytes) => {
      if (released) return;
      released = true;
      state.reserved -= bytes;
      state.used = Math.max(0, state.used + delta);
    };
  }
  private path(id: string): string {
    return join(this.root, identifier.parse(id));
  }
  private async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Recording directory is not a safe directory");
    if (process.platform !== "win32") await chmod(path, 0o700);
  }
  private async existingDirectory(path: string): Promise<void> {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Recording directory is not a safe directory");
  }
  private async recordingDirectory(id: string): Promise<string> {
    const path = this.path(id);
    await this.existingDirectory(this.root);
    await this.existingDirectory(path);
    return path;
  }
  private queue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([this.root, id]);
    const count = this.queuedOperations.get(key) ?? 0;
    if (count >= this.maxQueuedOperations)
      return Promise.reject(new Error("Recording operation queue limit exceeded"));
    this.queuedOperations.set(key, count + 1);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        const remaining = (this.queuedOperations.get(key) ?? 1) - 1;
        if (remaining) this.queuedOperations.set(key, remaining);
        else this.queuedOperations.delete(key);
      });
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
      return undefined;
    });
    return result;
  }
  private reserveBytes(bytes: number): () => void {
    const current = sharedQueuedBytes.get(this.root) ?? 0;
    if (bytes > this.maxQueuedBytes - current)
      throw new Error("Recording write queue byte limit exceeded");
    sharedQueuedBytes.set(this.root, current + bytes);
    return () => {
      const remaining = (sharedQueuedBytes.get(this.root) ?? bytes) - bytes;
      if (remaining) sharedQueuedBytes.set(this.root, remaining);
      else sharedQueuedBytes.delete(this.root);
    };
  }
  private async readFile(path: string, limit: number): Promise<Buffer> {
    const handle = await open(path, fsConstants.O_RDONLY | noFollow);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1)
        throw new Error("Recording file is not a safe regular file");
      if (info.size > limit) throw new Error("Recording file exceeds read limit");
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > limit) throw new Error("Recording file exceeds read limit");
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, total);
    } finally {
      await handle.close();
    }
  }
  private async syncDirectory(path: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(path, fsConstants.O_RDONLY | noFollow);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async writeTemporary(directory: string, bytes: Uint8Array): Promise<string> {
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      0o600,
    );
    try {
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      await handle.close().catch((failure: unknown) => cleanupErrors.push(failure));
      let retainedBytes = 0;
      await unlink(temporary).catch((failure: unknown) => {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") {
          retainedBytes = bytes.length;
          cleanupErrors.push(failure);
        }
      });
      if (cleanupErrors.length)
        throw Object.assign(
          new AggregateError([error, ...cleanupErrors], "Recording temporary cleanup failed"),
          { retainedBytes },
        );
      throw error;
    }
    await handle.close();
    return temporary;
  }
  private async writeAtomic(directory: string, name: string, bytes: Uint8Array): Promise<void> {
    const temporary = await this.writeTemporary(directory, bytes);
    try {
      await rename(temporary, join(directory, name));
      await this.syncDirectory(directory);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async create(input: RecordingMetadata): Promise<void> {
    assertJsonValue(input, 1024 * 1024);
    const parsed = metadataSchema.parse({ ...input, schemaVersion: input.schemaVersion ?? 1 });
    const encoded = Buffer.from(JSON.stringify(parsed));
    if (encoded.length > 1024 * 1024) throw new Error("Recording metadata exceeds size limit");
    await this.queue(parsed.recordingId, async () => {
      const finish = await this.reserveStorage(encoded.length);
      let created = false;
      try {
        await this.ensureDirectory(this.root);
        const path = this.path(parsed.recordingId);
        await mkdir(path, { mode: 0o700 });
        created = true;
        if (process.platform !== "win32") await chmod(path, 0o700);
        await this.syncDirectory(this.root);
        await this.writeAtomic(path, "metadata.json", encoded);
      } finally {
        finish(created ? encoded.length : 0);
      }
    });
  }
  async readMetadata(id: string): Promise<RecordingMetadata> {
    const override = this.recoveryOverrides.get(identifier.parse(id));
    if (override) return override;
    const path = await this.recordingDirectory(id);
    const parsed = metadataSchema.parse(
      JSON.parse(decodeUtf8(await this.readFile(join(path, "metadata.json"), 1024 * 1024))),
    );
    if (parsed.recordingId !== id) throw new Error("Recording metadata identity mismatch");
    return parsed;
  }

  async list(): Promise<{ recordings: RecordingMetadata[]; incomplete: string[] }> {
    try {
      await this.existingDirectory(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { recordings: [], incomplete: [] };
      throw error;
    }
    const entries = await readdir(this.root, { withFileTypes: true });
    if (entries.length > 10_000) throw new Error("Recording list exceeds its limit");
    const recordings: RecordingMetadata[] = [];
    const incomplete: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !identifier.safeParse(entry.name).success) continue;
      try {
        recordings.push(await this.readMetadata(entry.name));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          (await this.recordingEntryExists(entry.name))
        )
          incomplete.push(entry.name);
      }
    }
    recordings.sort((a, b) => b.startedAt - a.startedAt);
    return { recordings, incomplete };
  }

  private async eventTailWarning(path: string): Promise<string | null> {
    try {
      const handle = await open(join(path, "events.jsonl"), fsConstants.O_RDONLY | noFollow);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1) return "event-log-unreadable";
        if (!info.size) return null;
        const last = Buffer.alloc(1);
        const read = await handle.read(last, 0, 1, info.size - 1);
        return read.bytesRead !== 1 || last[0] !== 10 ? "incomplete-event-tail" : null;
      } finally {
        await handle.close();
      }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "event-log-unreadable";
    }
  }
  private async recoverRecording(id: string): Promise<void> {
    let metadata: RecordingMetadata;
    try {
      metadata = await this.readMetadata(id);
    } catch (error) {
      if (isCorruptMetadata(error)) return;
      throw error;
    }
    const errors = new Set(metadata.captureErrors ?? []);
    const warnings = new Set(metadata.recoveryWarnings ?? []);
    const needsPersist = this.recoveryOverrides.has(id);
    if (needsPersist) warnings.delete("recovery-write-failed");
    const addWarning = (warning: string) => {
      warnings.add(warning);
      if (errors.size < 100) errors.add(warning);
    };
    const path = await this.recordingDirectory(id);
    const names = await readdir(path);
    if (names.some((name) => name.startsWith(".") && name.endsWith(".tmp")))
      addWarning("unpublished-metadata");
    const tailWarning = await this.eventTailWarning(path);
    if (tailWarning) addWarning(tailWarning);
    const interrupted = metadata.status === "recording";
    if (
      !needsPersist &&
      !interrupted &&
      errors.size === (metadata.captureErrors?.length ?? 0) &&
      warnings.size === (metadata.recoveryWarnings?.length ?? 0)
    )
      return;
    const patch = {
      status: interrupted ? "interrupted" : metadata.status,
      ...(interrupted ? { endedAt: Date.now() } : {}),
      captureErrors: [...errors].slice(0, 100),
      recoveryWarnings: [...warnings].slice(0, 10),
    } as const;
    try {
      await this.updateMetadata(id, patch);
    } catch (error) {
      this.recoveryOverrides.set(id, {
        ...metadata,
        ...patch,
        recoveryWarnings: [
          ...new Set([...patch.recoveryWarnings.slice(0, 9), "recovery-write-failed"]),
        ],
      });
      throw error;
    }
  }
  async recover(): Promise<void> {
    try {
      await this.existingDirectory(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const entries = await readdir(this.root, { withFileTypes: true });
    if (entries.length > 10_000) throw new Error("Recording list exceeds its limit");
    const failures: unknown[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (/^\.deleted-[a-zA-Z0-9_-]{1,128}-[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entry.name)) {
        try {
          const tombstone = join(this.root, entry.name);
          const quota = await this.quotaState().catch(() => null);
          const bytes = quota ? await measureTree(tombstone).catch(() => null) : null;
          await rm(tombstone, { recursive: true });
          if (quota && bytes !== null) quota.used = Math.max(0, quota.used - bytes);
          await this.syncDirectory(this.root);
        } catch (error) {
          failures.push(error);
        }
      } else if (identifier.safeParse(entry.name).success) {
        try {
          await this.recoverRecording(entry.name);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Recording recovery could not save metadata");
  }

  private async recordingEntryExists(id: string): Promise<boolean> {
    try {
      const entry = await lstat(this.path(id));
      return entry.isDirectory() && !entry.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async readExportEvents(
    id: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Uint8Array; totalBytes: number }> {
    identifier.parse(id);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > 1024 * 1024
    )
      throw new Error("Invalid event range");
    return this.queue(id, async () => {
      const directory = await this.recordingDirectory(id);
      if ((await this.readMetadata(id)).status === "recording")
        throw new Error("Stop recording before sharing");
      let handle;
      try {
        handle = await open(join(directory, "events.jsonl"), fsConstants.O_RDONLY | noFollow);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && offset === 0)
          return { bytes: new Uint8Array(), totalBytes: 0 };
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || offset > stat.size)
          throw new Error("Invalid event file");
        const bytes = Buffer.alloc(Math.min(length, stat.size - offset));
        let done = 0;
        while (done < bytes.length) {
          const read = await handle.read(bytes, done, bytes.length - done, offset + done);
          if (!read.bytesRead) throw new Error("Event file changed while sharing");
          done += read.bytesRead;
        }
        return { bytes, totalBytes: stat.size };
      } finally {
        await handle.close();
      }
    });
  }

  async listShareAudit(id: string): Promise<unknown[]> {
    identifier.parse(id);
    return this.queue(id, async () => {
      const directory = await this.recordingDirectory(id);
      try {
        return shareAuditSchema.parse(
          JSON.parse(decodeUtf8(await this.readFile(join(directory, "shares.json"), 1024 * 1024))),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
  }

  async forgetCorruptShareAudit(id: string): Promise<void> {
    identifier.parse(id);
    await this.queue(id, async () => {
      const directory = await this.recordingDirectory(id);
      const path = join(directory, "shares.json");
      const info = await lstat(path);
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error("Share audit is unsafe");
      let corrupt = info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024;
      if (!corrupt) {
        const bytes = await this.readFile(path, 1024 * 1024);
        try {
          shareAuditSchema.parse(JSON.parse(decodeUtf8(bytes)));
        } catch (error) {
          if (
            !(error instanceof SyntaxError) &&
            !(error instanceof z.ZodError) &&
            !(error instanceof TypeError)
          )
            throw error;
          corrupt = true;
        }
      }
      if (!corrupt) throw new Error("Share audit is valid; remove entries individually");
      await rename(path, join(directory, `.corrupt-shares-${randomUUID()}`));
      await this.syncDirectory(directory);
    });
  }

  async changeShareAudit(
    id: string,
    input: { entry?: unknown; removeShareId?: string },
  ): Promise<void> {
    identifier.parse(id);
    const entry =
      input.entry === undefined ? undefined : shareAuditSchema.element.parse(input.entry);
    if (entry && entry.recordingId !== id) throw new Error("Recording audit identity mismatch");
    const remove =
      input.removeShareId === undefined ? undefined : z.string().uuid().parse(input.removeShareId);
    if ((!entry && !remove) || (entry && remove)) throw new Error("Invalid audit update");
    await this.queue(id, async () => {
      const directory = await this.recordingDirectory(id);
      let entries: z.infer<typeof shareAuditSchema> = [];
      try {
        entries = shareAuditSchema.parse(
          JSON.parse(decodeUtf8(await this.readFile(join(directory, "shares.json"), 1024 * 1024))),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      entries = entries.filter((item) => item.shareId !== (entry?.shareId ?? remove));
      if (entry) entries.push(entry);
      const encoded = Buffer.from(JSON.stringify(shareAuditSchema.parse(entries)));
      if (encoded.length > 1024 * 1024) throw new Error("Recording share audit exceeds size limit");
      const auditPath = join(directory, "shares.json");
      const oldSize = await lstat(auditPath)
        .then((info) => info.size)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return 0;
          throw error;
        });
      const existingNames = new Set(await readdir(directory));
      const delta = encoded.length - oldSize;
      const finish = await this.reserveStorage(Math.max(0, delta), true);
      let charge = encoded.length;
      try {
        await this.writeAtomic(directory, "shares.json", encoded);
        charge = delta;
      } catch (error) {
        try {
          const names = (await readdir(directory)).filter(
            (name) => name.startsWith(".") && name.endsWith(".tmp") && !existingNames.has(name),
          );
          const afterSize = await lstat(auditPath)
            .then((info) => info.size)
            .catch(() => 0);
          charge =
            afterSize -
            oldSize +
            (await survivingBytes(names.map((name) => join(directory, name))));
        } catch {
          /* Keep the conservative charge if accounting fails. */
        }
        throw error;
      } finally {
        finish(charge);
      }
    });
  }

  async delete(id: string): Promise<void> {
    identifier.parse(id);
    await this.queue(id, async () => {
      const quota = await this.quotaState().catch(() => null);
      const directory = await this.recordingDirectory(id);
      try {
        const entries = shareAuditSchema.parse(
          JSON.parse(decodeUtf8(await this.readFile(join(directory, "shares.json"), 1024 * 1024))),
        );
        if (entries.length) throw new Error("Remove shared copies before deleting the recording");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const bytes = quota ? await measureTree(directory).catch(() => null) : null;
      const tombstone = join(this.root, `.deleted-${id}-${randomUUID()}`);
      await rename(directory, tombstone);
      await this.syncDirectory(this.root);
      await rm(tombstone, { recursive: true });
      this.recoveryOverrides.delete(id);
      if (quota && bytes !== null) quota.used = Math.max(0, quota.used - bytes);
      await this.syncDirectory(this.root);
    });
  }
  async updateMetadata(
    id: string,
    patch: Partial<
      Pick<
        RecordingMetadata,
        | "status"
        | "title"
        | "endedAt"
        | "captureErrors"
        | "recoveryWarnings"
        | "audioStatus"
        | "audioReason"
      >
    >,
  ): Promise<void> {
    identifier.parse(id);
    const parsedPatch = z
      .object({
        status: metadataSchema.shape.status.optional(),
        title: metadataSchema.shape.title,
        endedAt: metadataSchema.shape.endedAt,
        captureErrors: metadataSchema.shape.captureErrors,
        recoveryWarnings: metadataSchema.shape.recoveryWarnings,
        audioStatus: metadataSchema.shape.audioStatus,
        audioReason: metadataSchema.shape.audioReason,
      })
      .strict()
      .parse(patch);
    const allowed = Object.fromEntries(
      Object.entries(parsedPatch).filter(([, value]) => value !== undefined),
    );
    await this.queue(id, async () => {
      const current = await this.readMetadata(id);
      const next = metadataSchema.parse({ ...current, ...allowed });
      assertJsonValue(next, 1024 * 1024);
      const encoded = Buffer.from(JSON.stringify(next));
      if (encoded.length > 1024 * 1024) throw new Error("Recording metadata exceeds size limit");
      const path = await this.recordingDirectory(id);
      const oldSize = (await lstat(join(path, "metadata.json"))).size;
      const existingNames = new Set(await readdir(path));
      const delta = encoded.length - oldSize;
      const essential =
        allowed.status !== undefined ||
        allowed.endedAt !== undefined ||
        allowed.captureErrors !== undefined ||
        allowed.recoveryWarnings !== undefined;
      const finish = await this.reserveStorage(Math.max(0, delta), essential).catch(
        (error: unknown) => {
          if (essential) return () => {};
          throw error;
        },
      );
      let written = false;
      let failedCharge = encoded.length;
      try {
        await this.writeAtomic(path, "metadata.json", encoded);
        written = true;
        this.recoveryOverrides.delete(id);
      } catch (error) {
        try {
          const names = (await readdir(path)).filter(
            (name) => name.startsWith(".") && name.endsWith(".tmp") && !existingNames.has(name),
          );
          const afterSize = (await lstat(join(path, "metadata.json"))).size;
          failedCharge =
            afterSize - oldSize + (await survivingBytes(names.map((name) => join(path, name))));
        } catch {
          /* Keep the conservative charge when accounting is unavailable. */
        }
        throw error;
      } finally {
        finish(written ? delta : failedCharge);
      }
    });
  }
  async appendEvent(id: string, event: StoredRecordingEvent): Promise<void> {
    identifier.parse(id);
    assertJsonValue(event, this.maxEventBytes);
    const parsed = eventSchema.parse(event);
    if (parsed.recordingId !== id) throw new Error("Event recording identity mismatch");
    const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`);
    if (bytes.length > this.maxEventBytes) throw new Error("Recording event exceeds size limit");
    const release = this.reserveBytes(bytes.length);
    try {
      await this.queue(id, async () => {
        const finish = await this.reserveStorage(bytes.length);
        let charge = 0;
        try {
          const path = await this.recordingDirectory(id);
          const handle = await open(
            join(path, "events.jsonl"),
            fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_APPEND | noFollow,
            0o600,
          );
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink !== 1)
              throw new Error("Recording event file is not safe");
            if (process.platform !== "win32") await handle.chmod(0o600);
            if (info.size) {
              const last = Buffer.alloc(1);
              const read = await handle.read(last, 0, 1, info.size - 1);
              if (read.bytesRead !== 1 || last[0] !== 10)
                throw new Error("Recording event file has an incomplete trailing record");
            }
            try {
              charge = bytes.length;
              await handle.writeFile(bytes);
              // Per-record sync preserves the completed prefix on a process crash;
              // queue limits are surfaced to the caller when storage cannot keep up.
              await handle.sync();
            } catch (error) {
              try {
                await handle.truncate(info.size);
                await handle.sync();
                charge = 0;
              } catch (rollbackError) {
                throw appendRollbackFailure(error, rollbackError);
              }
              throw error;
            }
            if (info.size === 0) await this.syncDirectory(path);
          } finally {
            await handle.close();
          }
        } finally {
          finish(charge);
        }
      });
    } finally {
      release();
    }
  }
  async readEvents(
    id: string,
  ): Promise<{ events: StoredRecordingEvent[]; incompleteTail: boolean }> {
    identifier.parse(id);
    return this.queue(id, () => this.readEventsInternal(id));
  }
  private async readEventsInternal(
    id: string,
  ): Promise<{ events: StoredRecordingEvent[]; incompleteTail: boolean }> {
    const path = await this.recordingDirectory(id);
    let data: Buffer;
    try {
      data = await this.readFile(join(path, "events.jsonl"), this.maxEventReadBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { events: [], incompleteTail: false };
      throw error;
    }
    const incompleteTail = data.length > 0 && data[data.length - 1] !== 10;
    const lines = decodeUtf8(data.subarray(0, data.lastIndexOf(10) + 1)).split("\n");
    lines.pop();
    return {
      events: this.parseEventLines(id, lines),
      incompleteTail,
    };
  }
  private parseEventLines(id: string, lines: string[]): StoredRecordingEvent[] {
    return lines.map((line) => {
      if (Buffer.byteLength(line, "utf8") + 1 > this.maxEventBytes)
        throw new Error("Recording event exceeds size limit");
      const parsed = eventSchema.parse(JSON.parse(line));
      if (parsed.recordingId !== id) throw new Error("Event recording identity mismatch");
      return parsed;
    });
  }
  private validatePageInput(input: { cursor: number; maxBytes: number }): void {
    if (
      !Number.isSafeInteger(input.cursor) ||
      input.cursor < 0 ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes <= 0 ||
      input.maxBytes > 4 * 1024 * 1024
    )
      throw new Error("Invalid recording event cursor or page size");
  }
  private async validateCursor(
    handle: Awaited<ReturnType<typeof open>>,
    size: number,
    cursor: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(size)) throw new Error("Recording event file is too large");
    if (cursor > size) throw new Error("Invalid recording event cursor");
    if (cursor > 0) {
      const previous = Buffer.alloc(1);
      const read = await handle.read(previous, 0, 1, cursor - 1);
      if (read.bytesRead !== 1 || previous[0] !== 10)
        throw new Error("Recording event cursor is not at a record boundary");
    }
  }
  async readEventsPage(
    id: string,
    input: { cursor: number; maxBytes: number },
  ): Promise<{
    events: StoredRecordingEvent[];
    nextCursor: number | null;
    incompleteTail: boolean;
  }> {
    this.validatePageInput(input);
    identifier.parse(id);
    return this.queue(id, () => this.readEventsPageInternal(id, input));
  }
  async inspectEventsPage(id: string, input: { cursor: number; maxBytes: number }) {
    this.validatePageInput(input);
    identifier.parse(id);
    // A snapshot read does not wait behind a sustained durable-write backlog.
    // If it sees an append in progress, the caller receives an incomplete tail.
    return this.readEventsPageInternal(id, input);
  }
  private async readEventsPageInternal(
    id: string,
    input: { cursor: number; maxBytes: number },
  ): Promise<{
    events: StoredRecordingEvent[];
    nextCursor: number | null;
    incompleteTail: boolean;
  }> {
    const directory = await this.recordingDirectory(id);
    let handle;
    try {
      handle = await open(join(directory, "events.jsonl"), fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && input.cursor === 0)
        return { events: [], nextCursor: null, incompleteTail: false };
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error("Recording event file is not safe");
      await this.validateCursor(handle, info.size, input.cursor);
      const remaining = info.size - input.cursor;
      if (remaining === 0) return { events: [], nextCursor: null, incompleteTail: false };
      const length = Math.min(remaining, input.maxBytes + this.maxEventBytes);
      const data = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const read = await handle.read(data, offset, length - offset, input.cursor + offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset !== length) throw new Error("Recording event file changed during page read");
      const actual = data.subarray(0, offset);
      let end = actual.lastIndexOf(10, Math.min(input.maxBytes, actual.length) - 1);
      if (end < 0) end = actual.indexOf(10);
      if (end < 0) {
        if (offset >= this.maxEventBytes) throw new Error("Recording event exceeds size limit");
        return { events: [], nextCursor: null, incompleteTail: offset > 0 };
      }
      const consumed = end + 1;
      const lines = decodeUtf8(actual.subarray(0, consumed)).split("\n");
      lines.pop();
      const next = input.cursor + consumed;
      return {
        events: this.parseEventLines(id, lines),
        nextCursor: next < info.size ? next : null,
        incompleteTail: false,
      };
    } finally {
      await handle.close();
    }
  }
  private async mediaDirectory(id: string, streamId: string, create: boolean): Promise<string> {
    const recording = await this.recordingDirectory(id);
    const media = join(recording, "media");
    const stream = join(media, identifier.parse(streamId));
    if (create) {
      await this.ensureDirectory(media);
      await this.ensureDirectory(stream);
    } else {
      await this.existingDirectory(media);
      await this.existingDirectory(stream);
    }
    return stream;
  }
  async writeMediaSegment(id: string, segment: MediaSegment): Promise<void> {
    identifier.parse(id);
    const info = segmentSchema.parse({
      streamId: segment.streamId,
      segmentId: segment.segmentId,
      startMs: segment.startMs,
      durationMs: segment.durationMs,
      mimeType: segment.mimeType,
      ...(segment.track !== undefined ? { track: segment.track } : {}),
      ...(segment.codec !== undefined ? { codec: segment.codec } : {}),
      ...(segment.generationId !== undefined ? { generationId: segment.generationId } : {}),
      ...(segment.sequence !== undefined ? { sequence: segment.sequence } : {}),
    });
    if (
      !(segment.bytes instanceof Uint8Array) ||
      segment.bytes.byteLength > this.maxMediaSegmentBytes
    )
      throw new Error("Media segment exceeds size limit or has invalid bytes");
    const release = this.reserveBytes(segment.bytes.byteLength);
    try {
      // Snapshot caller-owned bytes before entering the queue.
      const bytes = Buffer.from(segment.bytes);
      const stored = storedSegmentSchema.parse({
        ...info,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const infoBytes = Buffer.from(JSON.stringify(stored));
      await this.queue(id, async () => {
        const finish = await this.reserveStorage(bytes.length + infoBytes.length);
        let charge = 0;
        let completed = false;
        let path: string | undefined;
        let dataTemp: string | undefined;
        let infoTemp: string | undefined;
        let attemptedPublication = false;
        let dataPublished = false;
        let retainedUnknown = 0;
        try {
          path = await this.mediaDirectory(id, info.streamId, true);
          const dataPath = join(path, `${info.segmentId}.bin`);
          const infoPath = join(path, `${info.segmentId}.json`);
          if ((await pathExists(dataPath)) || (await pathExists(infoPath)))
            throw new Error("Media segment already exists");
          try {
            dataTemp = await this.writeTemporary(path, bytes);
            infoTemp = await this.writeTemporary(path, infoBytes);
            attemptedPublication = true;
            await link(dataTemp, dataPath);
            dataPublished = true;
            await link(infoTemp, infoPath);
          } catch (error) {
            retainedUnknown =
              typeof (error as { retainedBytes?: unknown })?.retainedBytes === "number"
                ? (error as { retainedBytes: number }).retainedBytes
                : 0;
            if (dataPublished) await unlink(dataPath).catch(() => {});
            throw error;
          } finally {
            if (dataTemp) await unlink(dataTemp).catch(() => {});
            if (infoTemp) await unlink(infoTemp).catch(() => {});
          }
          await this.syncDirectory(path);
          completed = true;
        } finally {
          if (completed) charge = bytes.length + infoBytes.length;
          else if (path) {
            const candidates = [dataTemp, infoTemp].filter((value): value is string =>
              Boolean(value),
            );
            if (attemptedPublication)
              candidates.push(
                join(path, `${info.segmentId}.bin`),
                join(path, `${info.segmentId}.json`),
              );
            try {
              charge = retainedUnknown + (await survivingBytes(candidates));
            } catch {
              charge = 2 * (bytes.length + infoBytes.length);
            }
          } else charge = retainedUnknown;
          finish(charge);
        }
      });
    } finally {
      release();
    }
  }
  async readMediaSegment(id: string, streamId: string, segmentId: string): Promise<MediaSegment> {
    identifier.parse(id);
    identifier.parse(segmentId);
    return this.queue(id, async () => {
      const path = await this.mediaDirectory(id, streamId, false);
      await this.recoverPublishedLink(path, `${segmentId}.json`);
      await this.recoverPublishedLink(path, `${segmentId}.bin`);
      const stored = storedSegmentSchema.parse(
        JSON.parse(decodeUtf8(await this.readFile(join(path, `${segmentId}.json`), 64 * 1024))),
      );
      if (stored.streamId !== streamId || stored.segmentId !== segmentId)
        throw new Error("Media segment identity mismatch");
      const bytes = await this.readFile(join(path, `${segmentId}.bin`), this.maxMediaSegmentBytes);
      if (
        bytes.length !== stored.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== stored.sha256
      )
        throw new Error("Media segment integrity check failed");
      const { byteLength: _length, sha256: _sha, ...info } = stored;
      return { ...info, bytes: Uint8Array.from(bytes) };
    });
  }
  async readMediaSegmentRange(
    id: string,
    streamId: string,
    segmentId: string,
    input: { offset: number; length: number },
  ): Promise<{ bytes: Uint8Array; totalBytes: number; sha256: string }> {
    identifier.parse(id);
    identifier.parse(segmentId);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.length) ||
      input.length <= 0 ||
      input.length > 4 * 1024 * 1024
    )
      throw new Error("Invalid media segment range");
    return this.queue(id, async () => {
      const path = await this.mediaDirectory(id, streamId, false);
      await this.recoverPublishedLink(path, `${segmentId}.json`);
      await this.recoverPublishedLink(path, `${segmentId}.bin`);
      const info = storedSegmentSchema.parse(
        JSON.parse(decodeUtf8(await this.readFile(join(path, `${segmentId}.json`), 64 * 1024))),
      );
      if (info.streamId !== streamId || info.segmentId !== segmentId)
        throw new Error("Media segment identity mismatch");
      const handle = await open(join(path, `${segmentId}.bin`), fsConstants.O_RDONLY | noFollow);
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size !== info.byteLength ||
          stat.size > this.maxMediaSegmentBytes ||
          input.offset > stat.size
        )
          throw new Error("Invalid or unsafe media segment range");
        const size = Math.min(input.length, stat.size - input.offset);
        const bytes = Buffer.allocUnsafe(size);
        let readBytes = 0;
        while (readBytes < size) {
          const read = await handle.read(
            bytes,
            readBytes,
            size - readBytes,
            input.offset + readBytes,
          );
          if (!read.bytesRead) throw new Error("Media segment changed during range read");
          readBytes += read.bytesRead;
        }
        return { bytes, totalBytes: stat.size, sha256: info.sha256 };
      } finally {
        await handle.close();
      }
    });
  }
  private async recoverPublishedLink(directory: string, name: string): Promise<void> {
    const path = join(directory, name);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Media segment file is unsafe");
    if (entry.nlink === 1) return;
    let removed = false;
    const temporaryEntries = await opendir(directory);
    for await (const temporaryEntry of temporaryEntries) {
      const temporary = temporaryEntry.name;
      if (
        !/^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(
          temporary,
        )
      )
        continue;
      const tempPath = join(directory, temporary);
      const candidate = await lstat(tempPath);
      if (
        candidate.isFile() &&
        !candidate.isSymbolicLink() &&
        candidate.dev === entry.dev &&
        candidate.ino === entry.ino
      ) {
        await unlink(tempPath);
        removed = true;
      }
    }
    if (removed) await this.syncDirectory(directory);
    if ((await lstat(path)).nlink !== 1)
      throw new Error("Media segment file has an unsafe hardlink");
  }
  private async recoverTemporaryLink(directory: string, name: string): Promise<boolean> {
    const path = join(directory, name);
    const temporary = await lstat(path);
    if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink < 2) return false;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".bin")) continue;
      const candidate = await lstat(join(directory, entry.name));
      if (
        candidate.isFile() &&
        !candidate.isSymbolicLink() &&
        candidate.dev === temporary.dev &&
        candidate.ino === temporary.ino
      ) {
        await this.recoverPublishedLink(directory, entry.name);
        return !(await pathExists(path));
      }
    }
    return false;
  }
  private async inspectMediaEntry(
    path: string,
    streamId: string,
    name: string,
    names: Set<string>,
    unsafe: Set<string>,
    result: MediaSegmentListing,
  ): Promise<void> {
    const issue = (segmentId: string | null, reason: string) => {
      result.incomplete.push({ streamId, segmentId, reason });
    };
    if (name.endsWith(".tmp")) {
      issue(null, "Interrupted media temporary file remains");
      return;
    }
    if (name.endsWith(".bin")) {
      const segmentId = name.slice(0, -4);
      if (!identifier.safeParse(segmentId).success) issue(null, "Unexpected media segment name");
      else if (!names.has(`${segmentId}.json`))
        issue(segmentId, "Media segment metadata is missing");
      return;
    }
    if (!name.endsWith(".json")) {
      issue(null, "Unexpected media segment file");
      return;
    }
    const segmentId = name.slice(0, -5);
    if (!identifier.safeParse(segmentId).success) {
      issue(null, "Unexpected media segment name");
      return;
    }
    if (!names.has(`${segmentId}.bin`)) {
      issue(segmentId, "Media segment data is missing");
      return;
    }
    if (unsafe.has(name) || unsafe.has(`${segmentId}.bin`)) {
      issue(segmentId, "Media segment file is unsafe");
      return;
    }
    try {
      const stored = storedSegmentSchema.parse(
        JSON.parse(decodeUtf8(await this.readFile(join(path, name), 64 * 1024))),
      );
      const data = await lstat(join(path, `${segmentId}.bin`));
      if (
        stored.streamId !== streamId ||
        stored.segmentId !== segmentId ||
        !data.isFile() ||
        data.isSymbolicLink() ||
        data.nlink !== 1 ||
        data.size !== stored.byteLength ||
        data.size > this.maxMediaSegmentBytes
      )
        throw new Error("Invalid media segment");
      const { byteLength: _length, sha256: _sha, ...info } = stored;
      result.segments.push(info);
    } catch {
      issue(segmentId, "Media segment is unreadable");
    }
  }
  private async scanMediaStream(
    id: string,
    streamId: string,
    result: MediaSegmentListing,
  ): Promise<void> {
    if (!identifier.safeParse(streamId).success) {
      result.incomplete.push({
        streamId: null,
        segmentId: null,
        reason: "Unexpected media stream name",
      });
      return;
    }
    let path: string;
    try {
      path = await this.mediaDirectory(id, streamId, false);
    } catch {
      result.incomplete.push({
        streamId,
        segmentId: null,
        reason: "Media stream directory is unsafe",
      });
      return;
    }
    const unsafe = new Set<string>();
    for (const name of await readdir(path)) {
      if (!name.endsWith(".bin") && !name.endsWith(".json")) continue;
      try {
        await this.recoverPublishedLink(path, name);
      } catch {
        unsafe.add(name);
      }
    }
    const entries = await readdir(path);
    const names = new Set(entries);
    for (const name of entries)
      await this.inspectMediaEntry(path, streamId, name, names, unsafe, result);
  }
  private async scanMediaSegments(id: string): Promise<MediaSegmentListing> {
    const recording = await this.recordingDirectory(id);
    const media = join(recording, "media");
    try {
      await this.existingDirectory(media);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { segments: [], incomplete: [] };
      throw error;
    }
    const result: MediaSegmentListing = { segments: [], incomplete: [] };
    for (const streamId of await readdir(media)) await this.scanMediaStream(id, streamId, result);
    result.segments.sort(
      (a, b) =>
        a.startMs - b.startMs ||
        a.streamId.localeCompare(b.streamId) ||
        a.segmentId.localeCompare(b.segmentId),
    );
    return result;
  }
  async listMediaSegmentsWithGaps(id: string): Promise<MediaSegmentListing> {
    identifier.parse(id);
    return this.queue(id, () => this.scanMediaSegments(id));
  }
  async listMediaSegmentsPage(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<MediaSegmentListing & { nextCursor: string | null }> {
    identifier.parse(id);
    if (
      (cursor !== null && (typeof cursor !== "string" || cursor.length > 1024)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid media page");
    // Media pages recover interrupted publications, so serialize them with
    // other media reads and deletion. Active recordings are gated by IPC.
    return this.queue(id, () => this.listMediaSegmentsPageInternal(id, cursor, limit));
  }
  // eslint-disable-next-line complexity
  private async listMediaSegmentsPageInternal(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<MediaSegmentListing & { nextCursor: string | null }> {
    const recording = await this.recordingDirectory(id);
    const media = join(recording, "media");
    try {
      await this.existingDirectory(media);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { segments: [], incomplete: [], nextCursor: null };
      throw error;
    }
    // Keep only the next bounded set of names. The keyset cursor is independent
    // of filesystem enumeration order and of entries inserted before the cursor.
    const candidates: Array<{ key: string; stream: string; name: string | null }> = [];
    const add = (stream: string, name: string | null) => {
      const key = `${stream}/${name ?? ""}`;
      if (cursor !== null && key <= cursor) return;
      let low = 0;
      let high = candidates.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (candidates[mid].key < key) low = mid + 1;
        else high = mid;
      }
      candidates.splice(low, 0, { key, stream, name });
      if (candidates.length > limit + 1) candidates.pop();
    };
    const streams = await opendir(media);
    for await (const stream of streams) {
      if (
        !identifier.safeParse(stream.name).success ||
        !stream.isDirectory() ||
        stream.isSymbolicLink()
      ) {
        add(stream.name, null);
        continue;
      }
      let path: string;
      try {
        path = await this.mediaDirectory(id, stream.name, false);
      } catch {
        add(stream.name, null);
        continue;
      }
      const entries = await opendir(path);
      for await (const entry of entries) add(stream.name, entry.name);
    }
    const result: MediaSegmentListing & { nextCursor: string | null } = {
      segments: [],
      incomplete: [],
      nextCursor: candidates.length > limit ? candidates[limit - 1].key : null,
    };
    for (const candidate of candidates.slice(0, limit)) {
      if (candidate.name === null) {
        result.incomplete.push({
          streamId: null,
          segmentId: null,
          reason: "Media stream directory is unsafe",
        });
        continue;
      }
      let path: string;
      try {
        path = await this.mediaDirectory(id, candidate.stream, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const name = candidate.name;
      if (!(await pathExists(join(path, name)))) continue;
      if (name.endsWith(".tmp")) {
        try {
          if (await this.recoverTemporaryLink(path, name)) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      let other: string | null = null;
      if (name.endsWith(".json")) other = `${name.slice(0, -5)}.bin`;
      if (name.endsWith(".bin")) other = `${name.slice(0, -4)}.json`;
      const names = new Set([name]);
      if (other && (await pathExists(join(path, other)))) names.add(other);
      const unsafe = new Set<string>();
      for (const part of names) {
        if (!part.endsWith(".bin") && !part.endsWith(".json")) continue;
        try {
          await this.recoverPublishedLink(path, part);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") names.delete(part);
          else unsafe.add(part);
        }
      }
      if (!names.has(name)) continue;
      await this.inspectMediaEntry(path, candidate.stream, name, names, unsafe, result);
    }
    return result;
  }
  async listMediaSegments(id: string): Promise<MediaSegmentInfo[]> {
    const listing = await this.listMediaSegmentsWithGaps(id);
    if (listing.incomplete.length) throw new Error(listing.incomplete[0].reason);
    return listing.segments;
  }
}
