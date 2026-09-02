import { promises as fs } from "node:fs";

import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "./atomic-file.js";

/**
 * Id-keyed JSON store: one file per registry, whole-array atomic replace, schema-validated on
 * both read and write, with a serialized mutation queue so concurrent writers cannot interleave.
 *
 * A partially written file is never observable — `writeJsonFileAtomic` renames into place — but
 * the cache is only swapped in after the write lands, so a failed write leaves the in-memory
 * state matching disk rather than the attempted mutation.
 */
export class FileBackedRegistry<TRecord> {
  private readonly filePath: string;
  protected readonly logger: Logger;
  protected readonly schema: z.ZodType<TRecord, unknown>;
  private readonly getId: (record: TRecord) => string;
  private loaded = false;
  private readonly cache = new Map<string, TRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationsBlockedUntilRestart = false;
  private readonly writeRecords: (filePath: string, records: readonly TRecord[]) => Promise<void>;

  constructor(options: {
    filePath: string;
    logger: Logger;
    schema: z.ZodType<TRecord, unknown>;
    getId: (record: TRecord) => string;
    component: string;
    module?: string;
    writeRecords?: (filePath: string, records: readonly TRecord[]) => Promise<void>;
  }) {
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.getId = options.getId;
    this.logger = options.logger.child({
      module: options.module ?? "file-backed-registry",
      component: options.component,
    });
    this.writeRecords = options.writeRecords ?? writeJsonFileAtomic;
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async existsOnDisk(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<TRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(id: string): Promise<TRecord | null> {
    await this.load();
    return this.cache.get(id) ?? null;
  }

  async upsert(record: TRecord): Promise<void> {
    const parsed = this.schema.parse(record);
    await this.mutateCache((records) => {
      records.set(this.getId(parsed), parsed);
      return undefined;
    });
  }

  async update(id: string, updater: (record: TRecord) => TRecord): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing) return null;
      const next = this.schema.parse(updater(existing));
      records.set(id, next);
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.removeIfPresent(id);
  }

  protected async removeIfPresent(id: string): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing) return null;
      records.delete(id);
      return existing;
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.cache.clear();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = z.array(this.schema).parse(JSON.parse(raw));
      for (const record of parsed) {
        this.cache.set(this.getId(record), record);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load registry file");
      }
    }
    this.loaded = true;
  }

  protected async mutateMany(
    updater: (records: ReadonlyMap<string, TRecord>) => readonly TRecord[],
  ): Promise<TRecord[]> {
    return this.mutateCache((records) => {
      const changed = updater(records);
      if (changed.length === 0) return [];
      const parsed = changed.map((record) => this.schema.parse(record));
      for (const record of parsed) records.set(this.getId(record), record);
      return parsed;
    });
  }

  protected async mutateCache<TResult>(
    updater: (records: Map<string, TRecord>) => TResult,
    hooks?: {
      forcePersist?: (result: TResult) => boolean;
      beforeWrite?: (records: readonly TRecord[]) => Promise<void>;
      afterWrite?: () => Promise<void>;
      afterCommit?: () => void;
    },
  ): Promise<TResult> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.load();
      if (this.mutationsBlockedUntilRestart) {
        throw new Error("Registry mutations are blocked until daemon restart");
      }
      const staged = new Map(this.cache);
      const result = updater(staged);
      const recordsChanged = !mapsEqual(this.cache, staged);
      if (!recordsChanged && !hooks?.forcePersist?.(result)) return result;
      const records = Array.from(staged.values());
      await hooks?.beforeWrite?.(records);
      if (recordsChanged) await this.writeRecords(this.filePath, records);
      await hooks?.afterWrite?.();
      if (recordsChanged) {
        this.cache.clear();
        for (const [id, record] of staged) this.cache.set(id, record);
      }
      hooks?.afterCommit?.();
      return result;
    } finally {
      release();
    }
  }

  protected freezeMutationsUntilRestart(): void {
    this.mutationsBlockedUntilRestart = true;
  }
}

/** Records that carry the soft-delete pair the archive helpers below read and write. */
export interface ArchivableRecord {
  updatedAt: string;
  archivedAt: string | null;
}

export class ArchivableFileBackedRegistry<
  TRecord extends ArchivableRecord,
> extends FileBackedRegistry<TRecord> {
  async archive(id: string, archivedAt: string): Promise<void> {
    await this.archiveIfPresent(id, archivedAt);
  }

  protected async archiveIfPresent(id: string, archivedAt: string): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing) return null;
      const next = this.schema.parse({ ...existing, updatedAt: archivedAt, archivedAt });
      records.set(id, next);
      return next;
    });
  }

  protected async archiveIfActive(id: string, archivedAt: string): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing || existing.archivedAt) return null;
      const next = this.schema.parse({ ...existing, updatedAt: archivedAt, archivedAt });
      records.set(id, next);
      return next;
    });
  }
}

function mapsEqual<TKey, TValue>(left: Map<TKey, TValue>, right: Map<TKey, TValue>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}
