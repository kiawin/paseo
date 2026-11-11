import { createHash, randomUUID, type Hash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import {
  FileTransferOpcode,
  TRANSFER_ACK_INTERVAL_BYTES,
  TRANSFER_WINDOW_BYTES,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";

interface SegmentDeclaration {
  id: string;
  size: number;
  sha256: string;
}
interface Manifest {
  version: 1;
  segments: SegmentDeclaration[];
}
interface PendingShare {
  source: object;
  recipientAgentId: string;
  recordingId: string;
  manifest: Manifest;
  directory: string;
  completedSegments: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  expired: () => void;
  completing: boolean;
  cancelRequested: boolean;
  completionDone: Promise<void> | undefined;
}
interface Upload {
  source: object;
  shareId: string;
  segment: SegmentDeclaration;
  requestId: string;
  path: string;
  ready: Promise<FileHandle>;
  queue: Promise<void>;
  queuedBytes: number;
  bytes: number;
  ackedBytes: number;
  started: boolean;
  endQueued: boolean;
  trailingFrames: boolean;
  cancelled: boolean;
  hash: Hash;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  finished: (error: Error | null) => void;
  acknowledge: (bytesReceived: number) => void;
}
const rootInitializations = new Map<string, Promise<void>>();
const rootLocks = new Map<string, Promise<void>>();
const SHARE_QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
export const RECORDING_UPLOAD_CHUNK_BYTES = 256 * 1024;
export const RECORDING_UPLOAD_QUEUE_BYTES = TRANSFER_WINDOW_BYTES + RECORDING_UPLOAD_CHUNK_BYTES;

async function withRootLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = rootLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  rootLocks.set(root, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (rootLocks.get(root) === current) rootLocks.delete(root);
  }
}

async function reservedBytes(root: string): Promise<number> {
  let total = 0;
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entry.name)) continue;
    if (++count >= 512) throw new Error("Too many retained recording shares");
    const directory = join(root, entry.name);
    let content: string | undefined;
    for (const name of ["manifest.json", "manifest.pending.json"]) {
      try {
        const path = join(directory, name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024)
          throw new Error("Unsafe retained recording manifest");
        content = await readFile(path, "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!content) throw new Error("Recording share metadata is incomplete");
    total += reservedManifestBytes(content);
    if (total > SHARE_QUOTA_BYTES) throw new Error("Recording share quota exceeded");
  }
  return total;
}

function reservedManifestBytes(content: string): number {
  const parsed = JSON.parse(content) as { manifest?: { segments?: { size?: unknown }[] } };
  if (!Array.isArray(parsed.manifest?.segments) || parsed.manifest.segments.length > 1024)
    throw new Error("Recording share metadata is invalid");
  return parsed.manifest.segments.reduce((sum, segment) => {
    if (
      typeof segment.size !== "number" ||
      !Number.isSafeInteger(segment.size) ||
      segment.size < 0 ||
      segment.size > 16 * 1024 * 1024
    )
      throw new Error("Recording share metadata is invalid");
    return sum + segment.size;
  }, 0);
}

function initializeRoot(root: string): Promise<void> {
  const existing = rootInitializations.get(root);
  if (existing) return existing;
  const initialization = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe recording share directory");
    if (process.platform !== "win32") await chmod(root, 0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entry.name)) continue;
      const directory = join(root, entry.name);
      try {
        await lstat(join(directory, "manifest.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rm(directory, { recursive: true, force: true });
      }
    }
  })();
  rootInitializations.set(root, initialization);
  void initialization.catch(() => {
    if (rootInitializations.get(root) === initialization) rootInitializations.delete(root);
  });
  return initialization;
}

/** Private, source-owned staging for a recording selected by an authorized caller. */
export class RecordingShareStore {
  private readonly root: string;
  private readonly pending = new Map<string, PendingShare>();
  private readonly uploads = new Map<string, Upload>();
  private starting = 0;

  constructor(
    paseoHome: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.root = join(paseoHome, "recording-shares");
  }

  async begin(
    source: object,
    recipientAgentId: string,
    recordingId: string,
    manifest: Manifest,
    signal: AbortSignal,
    expired: () => void,
  ): Promise<string> {
    if (this.pending.size + this.starting >= 32)
      throw new Error("Too many active recording shares");
    if (
      new Set(manifest.segments.map((segment) => segment.id.toLowerCase())).size !==
      manifest.segments.length
    )
      throw new Error("Duplicate recording segment identifier");
    if (
      manifest.segments.some((segment) =>
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(segment.id),
      )
    )
      throw new Error("Reserved recording segment identifier");
    if (manifest.segments.reduce((sum, segment) => sum + segment.size, 0) > 1024 * 1024 * 1024)
      throw new Error("Recording share exceeds size limit");
    this.starting++;
    try {
      signal.throwIfAborted();
      await initializeRoot(this.root);
      return await withRootLock(this.root, async () => {
        signal.throwIfAborted();
        const rootInfo = await lstat(this.root);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
          throw new Error("Unsafe recording share directory");
        if (
          (await reservedBytes(this.root)) +
            manifest.segments.reduce((sum, segment) => sum + segment.size, 0) >
          SHARE_QUOTA_BYTES
        )
          throw new Error("Recording share quota exceeded");
        const shareId = randomUUID();
        const directory = join(this.root, shareId);
        await mkdir(directory, { mode: 0o700 });
        const entry: PendingShare = {
          source,
          recipientAgentId,
          recordingId,
          manifest,
          directory,
          completedSegments: new Set(),
          idleTimer: undefined,
          expired,
          completing: false,
          cancelRequested: false,
          completionDone: undefined,
        };
        this.pending.set(shareId, entry);
        this.armShareIdleTimer(shareId, entry);
        try {
          await writeFile(
            join(directory, "manifest.pending.json"),
            JSON.stringify({ recipientAgentId, recordingId, manifest }),
            { flag: "wx", mode: 0o600 },
          );
          signal.throwIfAborted();
          return shareId;
        } catch (error) {
          if (entry.idleTimer) clearTimeout(entry.idleTimer);
          this.pending.delete(shareId);
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      });
    } finally {
      this.starting--;
    }
  }

  async cancelSource(source: object): Promise<void> {
    const entries = [...this.pending].filter(([, entry]) => entry.source === source);
    const results = await Promise.allSettled(entries.map(([id]) => this.cancel(id)));
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Recording share cleanup failed",
      );
  }

  async cancel(shareId: string): Promise<void> {
    const entry = this.pending.get(shareId);
    if (!entry) return;
    if (entry.completing) {
      entry.cancelRequested = true;
      await entry.completionDone;
      return;
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.pending.delete(shareId);
    const uploads = [...this.uploads.values()].filter((upload) => upload.shareId === shareId);
    for (const upload of uploads) {
      upload.cancelled = true;
      if (upload.idleTimer) clearTimeout(upload.idleTimer);
    }
    await Promise.allSettled(uploads.map((upload) => upload.queue));
    await Promise.allSettled(uploads.map(async (upload) => (await upload.ready).close()));
    for (const upload of uploads) this.uploads.delete(upload.requestId);
    await withRootLock(this.root, () => rm(entry.directory, { recursive: true, force: true }));
  }

  private armShareIdleTimer(shareId: string, share: PendingShare): void {
    if (share.idleTimer) clearTimeout(share.idleTimer);
    share.idleTimer = setTimeout(() => {
      if (this.pending.get(shareId) !== share) return;
      if ([...this.uploads.values()].some((upload) => upload.shareId === shareId)) {
        this.armShareIdleTimer(shareId, share);
        return;
      }
      void this.cancel(shareId)
        .then(() => {
          share.expired();
          return undefined;
        })
        .catch(this.onError);
    }, 10 * 60_000);
    share.idleTimer.unref();
  }

  hasUpload(requestId: string, source?: object): boolean {
    const upload = this.uploads.get(requestId);
    return !!upload && (source === undefined || upload.source === source);
  }

  async cancelUpload(requestId: string, source: object, notify = false): Promise<void> {
    const upload = this.uploads.get(requestId);
    if (!upload || upload.source !== source) return;
    upload.cancelled = true;
    if (upload.idleTimer) clearTimeout(upload.idleTimer);
    this.uploads.delete(requestId);
    await upload.queue;
    await upload.ready.then((file) => file.close()).catch(() => {});
    await unlink(upload.path).catch(() => {});
    if (notify) upload.finished(new Error("Recording upload was cancelled"));
  }

  beginUpload(
    source: object,
    shareId: string,
    segmentId: string,
    requestId: string,
    finished: (error: Error | null) => void,
    acknowledge: (bytesReceived: number) => void,
  ): void {
    const share = this.pending.get(shareId);
    if (!share || share.source !== source) throw new Error("Recording share is unavailable");
    this.armShareIdleTimer(shareId, share);
    const segment = share.manifest.segments.find((item) => item.id === segmentId);
    if (
      !segment ||
      share.completedSegments.has(segmentId) ||
      [...this.uploads.values()].some(
        (upload) => upload.shareId === shareId && upload.segment.id === segmentId,
      )
    )
      throw new Error("Recording segment is unavailable");
    if (this.uploads.has(requestId) || this.uploads.size >= 32)
      throw new Error("Recording transfer is unavailable");
    const path = join(share.directory, `${segment.id}.part`);
    const ready = open(path, "wx", 0o600);
    void ready.catch(() => {});
    const upload: Upload = {
      source,
      shareId,
      segment,
      requestId,
      path,
      ready,
      queue: Promise.resolve(),
      queuedBytes: 0,
      bytes: 0,
      ackedBytes: 0,
      started: false,
      endQueued: false,
      trailingFrames: false,
      cancelled: false,
      hash: createHash("sha256"),
      idleTimer: undefined,
      finished,
      acknowledge,
    };
    this.uploads.set(requestId, upload);
    this.armIdleTimer(upload);
  }

  private armIdleTimer(upload: Upload): void {
    if (upload.idleTimer) clearTimeout(upload.idleTimer);
    upload.idleTimer = setTimeout(() => {
      if (this.uploads.get(upload.requestId) !== upload) return;
      void this.cancelUpload(upload.requestId, upload.source)
        .then(() => {
          upload.finished(new Error("Recording upload timed out"));
          return undefined;
        })
        .catch(() => upload.finished(new Error("Recording upload cleanup failed")));
    }, 60_000);
    upload.idleTimer.unref();
  }

  async receiveFrame(frame: FileTransferFrame, source: object): Promise<void> {
    const upload = this.uploads.get(frame.requestId);
    if (!upload || upload.source !== source) return;
    const share = this.pending.get(upload.shareId);
    if (share) this.armShareIdleTimer(upload.shareId, share);
    this.armIdleTimer(upload);
    if (upload.endQueued) {
      upload.trailingFrames = true;
      return;
    }
    if (frame.opcode === FileTransferOpcode.FileEnd) upload.endQueued = true;
    const length = frame.opcode === FileTransferOpcode.FileChunk ? frame.payload.byteLength : 0;
    upload.queuedBytes += length;
    const overflow =
      length > RECORDING_UPLOAD_CHUNK_BYTES || upload.queuedBytes > RECORDING_UPLOAD_QUEUE_BYTES;
    if (overflow) {
      upload.cancelled = true;
      if (upload.idleTimer) clearTimeout(upload.idleTimer);
      this.uploads.delete(upload.requestId);
      await upload.queue;
      await upload.ready.then((file) => file.close()).catch(() => {});
      await unlink(upload.path).catch(() => {});
      upload.finished(new Error("Recording transfer queue exceeded its limit"));
      return;
    }
    const work = upload.queue.then(async () => {
      if (upload.cancelled) return undefined;
      const file = await upload.ready;
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        if (upload.started) throw new Error("Duplicate recording segment start");
        upload.started = true;
      } else if (frame.opcode === FileTransferOpcode.FileChunk) {
        if (!upload.started || upload.bytes + length > upload.segment.size)
          throw new Error("Invalid recording segment length");
        await file.writeFile(frame.payload);
        upload.hash.update(frame.payload);
        upload.bytes += length;
        if (upload.bytes - upload.ackedBytes >= TRANSFER_ACK_INTERVAL_BYTES) {
          upload.ackedBytes = upload.bytes;
          upload.acknowledge(upload.bytes);
        }
      } else {
        if (
          !upload.started ||
          upload.trailingFrames ||
          upload.bytes !== upload.segment.size ||
          upload.hash.digest("hex") !== upload.segment.sha256
        )
          throw new Error("Recording segment integrity check failed");
        await file.sync();
        await file.close();
        const destination = join(
          this.pending.get(upload.shareId)!.directory,
          `${upload.segment.id}.bin`,
        );
        await rename(upload.path, destination);
        if (upload.trailingFrames || upload.cancelled) {
          await unlink(destination).catch(() => {});
          throw new Error("Unexpected recording data after segment end");
        }
        this.pending.get(upload.shareId)!.completedSegments.add(upload.segment.id);
        if (upload.idleTimer) clearTimeout(upload.idleTimer);
        this.uploads.delete(upload.requestId);
        upload.finished(null);
      }
      return undefined;
    });
    upload.queue = work
      .catch(async (error: unknown) => {
        if (upload.cancelled) return;
        upload.cancelled = true;
        if (upload.idleTimer) clearTimeout(upload.idleTimer);
        this.uploads.delete(upload.requestId);
        await upload.ready.then((file) => file.close()).catch(() => {});
        await unlink(upload.path).catch(() => {});
        upload.finished(error instanceof Error ? error : new Error("Recording segment failed"));
      })
      .finally(() => {
        upload.queuedBytes -= length;
      });
    await upload.queue;
  }

  async complete(source: object, shareId: string): Promise<string> {
    const share = this.pending.get(shareId);
    if (!share || share.source !== source) throw new Error("Recording share is unavailable");
    if (share.completing) throw new Error("Recording share is already completing");
    if (
      share.completedSegments.size !== share.manifest.segments.length ||
      [...this.uploads.values()].some((upload) => upload.shareId === shareId)
    )
      throw new Error("Recording share is incomplete");
    let finish!: () => void;
    share.completionDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    share.completing = true;
    if (share.idleTimer) clearTimeout(share.idleTimer);
    try {
      return await withRootLock(this.root, async () => {
        const destination = join(share.directory, "manifest.json");
        const metadata = await open(join(share.directory, "manifest.pending.json"), "r");
        try {
          await metadata.sync();
        } finally {
          await metadata.close();
        }
        if (share.cancelRequested) throw new Error("Recording share was cancelled");
        await rename(join(share.directory, "manifest.pending.json"), destination);
        this.pending.delete(shareId);
        if (process.platform !== "win32") {
          const directory = await open(share.directory, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
        return destination;
      });
    } finally {
      share.completing = false;
      try {
        if (this.pending.get(shareId) === share) {
          if (share.cancelRequested) await this.cancel(shareId);
          else this.armShareIdleTimer(shareId, share);
        }
      } finally {
        finish();
      }
    }
  }

  recipientFor(source: object, shareId: string): string {
    const share = this.pending.get(shareId);
    if (!share || share.source !== source) throw new Error("Recording share is unavailable");
    return share.recipientAgentId;
  }

  async deleteCompleted(shareId: string, recipientAgentId: string): Promise<void> {
    return withRootLock(this.root, async () => {
      const directory = join(this.root, shareId);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Recording share is unavailable");
      const metadataFile = join(directory, "manifest.json");
      const metadataInfo = await lstat(metadataFile);
      if (
        !metadataInfo.isFile() ||
        metadataInfo.isSymbolicLink() ||
        metadataInfo.nlink !== 1 ||
        metadataInfo.size > 1024 * 1024
      )
        throw new Error("Recording share is unavailable");
      const parsed = JSON.parse(await readFile(metadataFile, "utf8")) as {
        recipientAgentId?: unknown;
      };
      if (parsed.recipientAgentId !== recipientAgentId)
        throw new Error("Recording share recipient does not match");
      await rm(directory, { recursive: true, force: true });
    });
  }
}
