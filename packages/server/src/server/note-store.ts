import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { writeFileAtomic } from "./atomic-file.js";
import { FileBackedRegistry } from "./file-backed-registry.js";

export const NOTE_MAX_BYTES = 64 * 1024;
export const NOTE_MAX_PER_PROJECT = 500;
export const NOTE_MAX_BYTES_PER_PROJECT = 50 * 1024 * 1024;
export const NOTE_MAX_TITLE_LENGTH = 200;
export const NOTE_QUARANTINE_FILENAME = "index.quarantine";

export const PersistedNoteRecordSchema = z.object({
  noteId: z.string(),
  // Project identity is opaque. Legacy installations retain remote-shaped and path-shaped ids.
  projectId: z.string(),
  displayTitle: z.string().min(1).max(NOTE_MAX_TITLE_LENGTH),
  size: z.number().int().nonnegative(),
  contentSha256: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().positive(),
});

export type PersistedNoteRecord = z.infer<typeof PersistedNoteRecordSchema>;

export interface NoteLimits {
  maxPerProject: number;
  maxBytesPerProject: number;
}

export interface SaveNoteInput {
  projectId: string;
  /** The canonical name for the markdown payload. */
  body: string;
  noteId?: string | null;
}

export interface SaveNoteResult {
  record: PersistedNoteRecord;
  replaced: PersistedNoteRecord | null;
}

export type NoteChangeKind = "create" | "update" | "delete";

export interface NoteChange {
  projectId: string;
  noteId: string;
  revision: number | null;
  kind: NoteChangeKind;
}

export type NoteErrorCode =
  | "note_not_found"
  | "note_too_large"
  | "note_project_limit"
  | "note_revision_conflict"
  | "note_invalid_body";

export class NoteError extends Error {
  constructor(
    readonly code: NoteErrorCode,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "NoteError";
  }
}

interface PendingSave {
  record: PersistedNoteRecord;
  body: Buffer;
  replaced: PersistedNoteRecord | null;
}

interface CommittedSave {
  record: PersistedNoteRecord;
  replaced: PersistedNoteRecord | null;
}

interface ProjectUsage {
  count: number;
  bytes: number;
}

interface SaveRecordContext {
  input: SaveNoteInput;
  body: string;
  bodyBytes: Buffer;
  existing: PersistedNoteRecord | null;
  now: string;
}

function nextStamp(records: ReadonlyMap<string, PersistedNoteRecord>): string {
  let newest = 0;
  for (const record of records.values()) {
    const timestamp = Date.parse(record.updatedAt);
    if (Number.isFinite(timestamp)) newest = Math.max(newest, timestamp);
  }
  return new Date(Math.max(Date.now(), newest + 1)).toISOString();
}

function generateNoteId(): string {
  return `note_${randomBytes(8).toString("hex")}`;
}

function normalizeDisplayTitle(raw: string): string {
  return raw.trim().replace(/\s+/gu, " ").slice(0, NOTE_MAX_TITLE_LENGTH);
}

function titleFromHeading(lines: readonly string[], index: number): string | null {
  const match = lines[index]?.match(/^\s{0,3}#{1,6}(?:[ \t]+|$)(.*?)\s*$/u);
  if (match) {
    const heading = normalizeDisplayTitle(match[1].replace(/[ \t]+#+[ \t]*$/u, ""));
    if (heading) return heading;
  }

  const line = lines[index]?.trim();
  const underline = lines[index + 1]?.trim();
  if (line && underline && /^(?:=+|-+)$/u.test(underline)) {
    return normalizeDisplayTitle(line);
  }
  return null;
}

function contentStartAfterFrontmatter(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)$/u.test(lines[index]?.trim() ?? "")) return index + 1;
  }
  return 0;
}

function deriveDisplayTitle(body: string, createdAt: string): string {
  const lines = body.split(/\r?\n/u);
  const contentStart = contentStartAfterFrontmatter(lines);
  for (let index = contentStart; index < lines.length; index += 1) {
    const heading = titleFromHeading(lines, index);
    if (heading) return heading;
  }

  for (let index = contentStart; index < lines.length; index += 1) {
    const firstNonEmptyLine = normalizeDisplayTitle(lines[index]);
    if (firstNonEmptyLine) return firstNonEmptyLine;
  }

  return normalizeDisplayTitle(`Note created ${createdAt}`);
}

function noteProjectDirectory(root: string, projectId: string): string {
  const projectDirectory = createHash("sha256").update(projectId, "utf8").digest("hex");
  return path.join(root, projectDirectory);
}

function resolveExistingNote(
  records: ReadonlyMap<string, PersistedNoteRecord>,
  input: SaveNoteInput,
): PersistedNoteRecord | null {
  const noteId = input.noteId ?? null;
  const existing = noteId === null ? null : records.get(noteId);
  if (noteId !== null && !existing) {
    throw new NoteError("note_not_found", `No note ${noteId}`);
  }
  if (existing && existing.projectId !== input.projectId) {
    throw new NoteError("note_not_found", `No note ${noteId} in project ${input.projectId}`);
  }
  return existing ?? null;
}

function projectUsage(
  records: ReadonlyMap<string, PersistedNoteRecord>,
  projectId: string,
): ProjectUsage {
  let count = 0;
  let bytes = 0;
  for (const record of records.values()) {
    if (record.projectId !== projectId) continue;
    count += 1;
    bytes += record.size;
  }
  return { count, bytes };
}

function assertProjectLimits(
  usage: ProjectUsage,
  existing: PersistedNoteRecord | null,
  bodyBytes: Buffer,
  limits: NoteLimits,
): void {
  if (existing === null && usage.count >= limits.maxPerProject) {
    throw new NoteError(
      "note_project_limit",
      `Project already has ${usage.count} notes, at the ${limits.maxPerProject} note limit`,
    );
  }

  const nextBytes = usage.bytes - (existing?.size ?? 0) + bodyBytes.byteLength;
  if (nextBytes > limits.maxBytesPerProject) {
    throw new NoteError(
      "note_project_limit",
      `Project notes use ${nextBytes} bytes, over the ${limits.maxBytesPerProject} byte limit`,
    );
  }
}

function createNoteRecord({
  input,
  body,
  bodyBytes,
  existing,
  now,
}: SaveRecordContext): PersistedNoteRecord {
  return PersistedNoteRecordSchema.parse({
    noteId: existing?.noteId ?? generateNoteId(),
    projectId: input.projectId,
    displayTitle: deriveDisplayTitle(body, existing?.createdAt ?? now),
    size: bodyBytes.byteLength,
    contentSha256: createHash("sha256").update(bodyBytes).digest("hex"),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    revision: (existing?.revision ?? 0) + 1,
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function errorErrno(error: unknown): number | string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("errno" in error) {
    const errno = error.errno;
    if (typeof errno === "number" || typeof errno === "string") return errno;
  }
  return errorCode(error);
}

async function storedFiles(directory: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await storedFiles(fullPath)));
    else files.push(fullPath);
  }
  return files;
}

export class NoteStore extends FileBackedRegistry<PersistedNoteRecord> {
  private readonly root: string;
  private readonly indexPath: string;
  private readonly quarantinePath: string;
  private readonly limits: NoteLimits;
  private readonly detailedChangeListeners = new Set<(change: NoteChange) => void>();

  constructor(root: string, logger: Logger, limits?: Partial<NoteLimits>) {
    const indexPath = path.join(root, "index.json");
    super({
      filePath: indexPath,
      logger,
      schema: PersistedNoteRecordSchema,
      getId: (record) => record.noteId,
      component: "note-store",
      module: "notes",
    });
    this.root = root;
    this.indexPath = indexPath;
    this.quarantinePath = path.join(root, NOTE_QUARANTINE_FILENAME);
    this.limits = {
      maxPerProject: limits?.maxPerProject ?? NOTE_MAX_PER_PROJECT,
      maxBytesPerProject: limits?.maxBytesPerProject ?? NOTE_MAX_BYTES_PER_PROJECT,
    };
  }

  subscribeToDetailedChanges(listener: (change: NoteChange) => void): () => void {
    this.detailedChangeListeners.add(listener);
    return () => this.detailedChangeListeners.delete(listener);
  }

  private notifyChanged(change: NoteChange): void {
    this.notifyDetailedChanged(change);
  }

  private notifyDetailedChanged(change: NoteChange): void {
    for (const listener of this.detailedChangeListeners) {
      try {
        listener(change);
      } catch (error) {
        this.logger.error({ err: error, ...change }, "Note change listener failed");
      }
    }
  }

  override async initialize(): Promise<void> {
    const markerPresent = await this.fileExists(this.quarantinePath);
    const indexValid = markerPresent || (await this.validateIndex());
    const quarantined = markerPresent || !indexValid;

    if (!markerPresent && !indexValid) {
      await writeFileAtomic(this.quarantinePath, "The note index is quarantined.\n");
      this.logger.error(
        { filePath: this.indexPath, quarantinePath: this.quarantinePath },
        "Quarantined invalid note index; mutations are blocked",
      );
    }
    if (quarantined) this.freezeMutationsUntilRestart();

    await super.initialize();
    if (!quarantined) await this.sweepOrphans();
  }

  async listForProject(projectId: string): Promise<PersistedNoteRecord[]> {
    const records = await this.list();
    return records
      .filter((record) => record.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readContent(record: PersistedNoteRecord): Promise<Buffer> {
    try {
      return await fs.readFile(this.contentPath(record));
    } catch {
      throw new NoteError("note_not_found", `Note ${record.noteId} has no stored content`);
    }
  }

  async save(input: SaveNoteInput): Promise<SaveNoteResult> {
    const body = resolveBody(input);
    const bodyBytes = Buffer.from(body, "utf8");
    if (bodyBytes.byteLength > NOTE_MAX_BYTES) {
      throw new NoteError(
        "note_too_large",
        `Note is ${bodyBytes.byteLength} bytes, over the ${NOTE_MAX_BYTES} byte limit`,
      );
    }

    let pending: PendingSave | null = null;
    const committed = await this.mutateCache<CommittedSave>(
      (records) => {
        const existing = resolveExistingNote(records, input);
        assertProjectLimits(
          projectUsage(records, input.projectId),
          existing,
          bodyBytes,
          this.limits,
        );
        const now = nextStamp(records);
        const record = createNoteRecord({ input, body, bodyBytes, existing, now });
        records.set(record.noteId, record);
        pending = { record, body: bodyBytes, replaced: existing ?? null };
        return { record, replaced: existing ?? null };
      },
      {
        beforeWrite: async () => {
          if (!pending) return;
          await writeFileAtomic(this.contentPath(pending.record), pending.body);
        },
        afterWrite: async () => {
          if (
            !pending?.replaced ||
            pending.replaced.contentSha256 === pending.record.contentSha256
          ) {
            return;
          }
          await this.unlinkContent(pending.replaced);
        },
      },
    );
    this.notifyChanged({
      projectId: input.projectId,
      noteId: committed.record.noteId,
      revision: committed.record.revision,
      kind: committed.replaced ? "update" : "create",
    });
    return committed;
  }

  async delete(noteId: string, expectedRevision: number): Promise<void> {
    const removed = await this.mutateCache<PersistedNoteRecord>((records) => {
      const existing = records.get(noteId);
      if (!existing) throw new NoteError("note_not_found", `No note ${noteId}`);
      if (existing.revision !== expectedRevision) {
        throw new NoteError(
          "note_revision_conflict",
          `Note ${noteId} is at revision ${existing.revision}, not ${expectedRevision}`,
          existing.revision,
        );
      }
      records.delete(noteId);
      return existing;
    });
    await this.unlinkContent(removed);
    this.notifyChanged({
      projectId: removed.projectId,
      noteId: removed.noteId,
      revision: null,
      kind: "delete",
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    const removed = await this.mutateCache<PersistedNoteRecord[]>((records) => {
      const victims = [...records.values()].filter((record) => record.projectId === projectId);
      for (const victim of victims) records.delete(victim.noteId);
      return victims;
    });
    for (const record of removed) await this.unlinkContent(record);
    await fs.rm(noteProjectDirectory(this.root, projectId), { recursive: true, force: true });
    for (const record of removed) {
      this.notifyDetailedChanged({
        projectId,
        noteId: record.noteId,
        revision: null,
        kind: "delete",
      });
    }
  }

  contentPath(record: Pick<PersistedNoteRecord, "projectId" | "noteId" | "contentSha256">): string {
    return path.join(
      noteProjectDirectory(this.root, record.projectId),
      `${record.noteId}.${record.contentSha256}.md`,
    );
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async validateIndex(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      z.array(PersistedNoteRecordSchema).parse(JSON.parse(raw));
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      this.logger.error({ err: error, filePath: this.indexPath }, "Failed to validate note index");
      return false;
    }
  }

  private async unlinkContent(record: PersistedNoteRecord): Promise<void> {
    try {
      await fs.rm(this.contentPath(record), { force: true });
    } catch (error) {
      this.logger.error({ err: error, noteId: record.noteId }, "Failed to remove note content");
    }
  }

  private async sweepOrphans(): Promise<void> {
    const records = await this.list();
    const expectedFiles = new Set(records.map((record) => this.contentPath(record)));
    const presentFiles = new Set<string>();
    const failedProjectDirectories = new Set<string>();
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDirectory = path.join(this.root, entry.name);
      let files: string[];
      try {
        files = await storedFiles(projectDirectory);
      } catch (error) {
        failedProjectDirectories.add(projectDirectory);
        this.logger.warn(
          { err: error, path: projectDirectory, errno: errorErrno(error) },
          "Failed to scan note content directory; preserving note records",
        );
        continue;
      }
      for (const fullPath of files) {
        if (expectedFiles.has(fullPath)) {
          presentFiles.add(fullPath);
          continue;
        }
        await fs.rm(fullPath, { force: true });
        this.logger.warn({ path: fullPath }, "Removed orphaned note content");
      }
    }

    for (const record of records) {
      const expectedPath = this.contentPath(record);
      if (failedProjectDirectories.has(path.dirname(expectedPath))) continue;
      if (presentFiles.has(expectedPath)) continue;
      await this.remove(record.noteId);
      this.logger.warn({ noteId: record.noteId }, "Dropped note record with no stored content");
    }
  }
}

function resolveBody(input: SaveNoteInput): string {
  if (typeof input.body !== "string")
    throw new NoteError("note_invalid_body", "Note body is required");
  return input.body;
}
