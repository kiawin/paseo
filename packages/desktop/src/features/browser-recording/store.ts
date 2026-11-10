import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
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
  })
  .passthrough();
const eventSchema = z
  .object({
    recordingId: identifier,
    memberId: z.string().min(1).max(256),
    webContentsId: z.number().int().nonnegative(),
    frameId: z.string().max(256).optional(),
    documentId: z.string().max(256).optional(),
    frameAttribution: z.enum(["identified", "unattributed"]),
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
}
const noFollow = fsConstants.O_NOFOLLOW ?? 0;
const sharedQueues = new Map<string, Promise<void>>();
const sharedQueueCounts = new Map<string, number>();
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
  private readonly queuedOperations = sharedQueueCounts;
  constructor(root: string, options: Options = {}) {
    if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root)
      throw new Error("Recording root must be an absolute non-root directory");
    this.root = resolve(root);
    this.maxMediaSegmentBytes = options.maxMediaSegmentBytes ?? 64 * 1024 * 1024;
    this.maxEventBytes = options.maxEventBytes ?? 8 * 1024 * 1024;
    this.maxEventReadBytes = options.maxEventReadBytes ?? 64 * 1024 * 1024;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 128 * 1024 * 1024;
    this.maxQueuedOperations = options.maxQueuedOperations ?? 1024;
    for (const limit of [
      this.maxMediaSegmentBytes,
      this.maxEventBytes,
      this.maxEventReadBytes,
      this.maxQueuedBytes,
      this.maxQueuedOperations,
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
      await handle.close();
      await unlink(temporary).catch(() => {});
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
      await this.ensureDirectory(this.root);
      const path = this.path(parsed.recordingId);
      await mkdir(path, { mode: 0o700 });
      if (process.platform !== "win32") await chmod(path, 0o700);
      await this.syncDirectory(this.root);
      await this.writeAtomic(path, "metadata.json", encoded);
    });
  }
  async readMetadata(id: string): Promise<RecordingMetadata> {
    const path = await this.recordingDirectory(id);
    const parsed = metadataSchema.parse(
      JSON.parse(decodeUtf8(await this.readFile(join(path, "metadata.json"), 1024 * 1024))),
    );
    if (parsed.recordingId !== id) throw new Error("Recording metadata identity mismatch");
    return parsed;
  }
  async updateMetadata(
    id: string,
    patch: Partial<Pick<RecordingMetadata, "status" | "title" | "endedAt" | "captureErrors">>,
  ): Promise<void> {
    identifier.parse(id);
    const parsedPatch = z
      .object({
        status: metadataSchema.shape.status.optional(),
        title: metadataSchema.shape.title,
        endedAt: metadataSchema.shape.endedAt,
        captureErrors: metadataSchema.shape.captureErrors,
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
      await this.writeAtomic(path, "metadata.json", encoded);
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
            await handle.writeFile(bytes);
            // Per-record sync preserves the completed prefix on a process crash;
            // queue limits are surfaced to the caller when storage cannot keep up.
            await handle.sync();
          } catch (error) {
            try {
              await handle.truncate(info.size);
              await handle.sync();
            } catch (rollbackError) {
              throw appendRollbackFailure(error, rollbackError);
            }
            throw error;
          }
          if (info.size === 0) await this.syncDirectory(path);
        } finally {
          await handle.close();
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
      await this.queue(id, async () => {
        const path = await this.mediaDirectory(id, info.streamId, true);
        const dataTemp = await this.writeTemporary(path, bytes);
        let infoTemp: string | undefined;
        let published = false;
        try {
          infoTemp = await this.writeTemporary(path, Buffer.from(JSON.stringify(stored)));
          await link(dataTemp, join(path, `${info.segmentId}.bin`));
          published = true;
          await link(infoTemp, join(path, `${info.segmentId}.json`));
        } catch (error) {
          if (published) await unlink(join(path, `${info.segmentId}.bin`)).catch(() => {});
          throw error;
        } finally {
          await unlink(dataTemp).catch(() => {});
          if (infoTemp) await unlink(infoTemp).catch(() => {});
        }
        await this.syncDirectory(path);
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
    for (const temporary of await readdir(directory)) {
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
  async listMediaSegments(id: string): Promise<MediaSegmentInfo[]> {
    const listing = await this.listMediaSegmentsWithGaps(id);
    if (listing.incomplete.length) throw new Error(listing.incomplete[0].reason);
    return listing.segments;
  }
}
