import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { writeFileAtomic } from "./atomic-file.js";
import { FileBackedRegistry } from "./file-backed-registry.js";

/** Rejected before any write. Comfortably under Claude's own 16 MB artifact ceiling. */
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_MAX_PER_PROJECT = 100;
export const ARTIFACT_MAX_BYTES_PER_PROJECT = 200 * 1024 * 1024;
export const ARTIFACT_MAX_TITLE_LENGTH = 200;

const ARTIFACT_MIME_TYPE = "text/html";

export const PersistedArtifactRecordSchema = z.object({
  artifactId: z.string(),
  // Project identity, never projectKey (reconciliation rewrites that) and never cwd (which
  // fragments one project's artifacts across its worktrees).
  projectId: z.string(),
  title: z.string(),
  // One value today. A field so a second document type stays additive.
  mimeType: z.literal(ARTIFACT_MIME_TYPE),
  /**
   * Null on both when Paseo holds no bytes — the artifact is a title pointing at `externalUrl`.
   *
   * `contentSha256 === null` is the single source of truth for that, checked identically by the
   * startup sweep, the viewer and the download RPC. A record that claims a digest must have its
   * file; a record that claims none must not.
   */
  size: z.number().nullable(),
  contentSha256: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pinned: z.boolean(),
  /** Companion link to the same document published elsewhere. `http:` / `https:` only. */
  externalUrl: z.string().nullable(),
  origin: z.object({
    agentId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    provider: z.string().nullable(),
    /**
     * Provider-side tool-call id, when the artifact came from capturing a tool result. Paired
     * with `origin.agentId` it is the idempotency key: a replayed history load resolves to the
     * record it already produced instead of publishing a duplicate.
     */
    callId: z.string().nullable(),
  }),
});

export type PersistedArtifactRecord = z.infer<typeof PersistedArtifactRecordSchema>;

export interface ArtifactOrigin {
  agentId: string | null;
  workspaceId: string | null;
  provider: string | null;
  callId?: string | null;
}

export interface PublishArtifactInput {
  projectId: string;
  title: string;
  /** Omit to record a link-only artifact, which then requires `externalUrl`. */
  html?: string | null;
  /**
   * Leave the target's stored document in place when this publication carries none. Capture sets
   * it: the copy it files comes from a scratch file the agent wrote, and a re-file once that file
   * is gone — history replay, or a later edit of the same page — must not strip the bytes off a
   * record that has them. A publish that means to turn a document back into a bare link omits it.
   */
  keepExistingContent?: boolean;
  /** Overwrite this record instead of minting one. Requires origin ownership. */
  artifactId?: string | null;
  externalUrl?: string | null;
  origin: ArtifactOrigin;
}

export interface PublishArtifactResult {
  record: PersistedArtifactRecord;
  evictedArtifactIds: string[];
}

/**
 * What one committed publish leaves behind to clean up.
 *
 * Carried out of the mutation rather than captured in a closure so the records are typed where
 * they are used: a `let` assigned inside the callback reads back as `null` to control-flow
 * analysis, and the unlink below would need a cast to see it at all.
 */
interface CommittedPublish {
  record: PersistedArtifactRecord;
  /** The record this publish overwrote, if it overwrote one. */
  superseded: PersistedArtifactRecord | null;
  evicted: PersistedArtifactRecord[];
}

export class ArtifactError extends Error {
  constructor(
    readonly code:
      | "artifact_not_found"
      | "artifact_too_large"
      | "artifact_invalid_title"
      | "artifact_invalid_external_url"
      | "artifact_forbidden"
      | "artifact_has_no_content",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

/**
 * `updatedAt` is the eviction order, so two publishes landing in the same millisecond must still
 * be ordered. Advance past the newest stamp on disk rather than trusting wall-clock resolution.
 */
function nextStamp(records: ReadonlyMap<string, PersistedArtifactRecord>): string {
  let newest = 0;
  for (const record of records.values()) {
    newest = Math.max(newest, Date.parse(record.updatedAt));
  }
  return new Date(Math.max(Date.now(), newest + 1)).toISOString();
}

function generateArtifactId(): string {
  return `art_${randomBytes(8).toString("hex")}`;
}

function normalizeTitle(raw: string): string {
  const title = raw.trim().replace(/\s+/g, " ");
  if (!title) throw new ArtifactError("artifact_invalid_title", "Artifact title cannot be empty");
  return title.slice(0, ARTIFACT_MAX_TITLE_LENGTH);
}

function normalizeExternalUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ArtifactError("artifact_invalid_external_url", `Not a URL: ${raw}`);
  }
  // Mirrors the allowlist `openExternalUrl` enforces at the other end of this field.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ArtifactError(
      "artifact_invalid_external_url",
      `Artifact links must be http or https, got ${parsed.protocol}`,
    );
  }
  return parsed.toString();
}

/**
 * Project-scoped store for agent-published HTML documents.
 *
 * Bytes live beside the index rather than in it:
 * `<root>/<projectId>/<artifactId>.<contentSha256>.html`, with `<root>/index.json` holding only
 * metadata. A publish is therefore not one write, so every step that decides or mutates runs
 * inside the inherited mutation queue — quota selection and index commit share one lock, or two
 * concurrent publishes each pick the other as the victim.
 *
 * Ordering is: the new HTML written and renamed into place, then the index commits, then the
 * superseded and evicted files are unlinked. Nothing is ever overwritten in place, which is what
 * makes a crash safe at any point: until the index commits it still names the old digest, and
 * that file is still there. A crash in either gap leaves an HTML file no record points at, which
 * `sweepOrphans` reclaims at startup — an orphan otherwise counts against the project quota
 * forever.
 */
export interface ArtifactLimits {
  maxPerProject: number;
  maxBytesPerProject: number;
}

/**
 * Every file under `dir`, at any depth.
 *
 * A `projectId` is itself a path — `remote:<host>/<owner>/<repo>` for a git project, the project
 * root path for a local one — so a project's directory sits an arbitrary number of levels below
 * the store root and no two projects need share a depth. Walking to files is what makes the sweep
 * independent of that shape. Listing a fixed one level down instead compares a directory against
 * the expected file paths, matches nothing, and unlinks it: `fs.rm` without `recursive` throws
 * EISDIR on a directory, which fails startup, and clearing that throw would drop every record as
 * content-less on the pass below.
 */
async function storedFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await storedFiles(full)));
    else found.push(full);
  }
  return found;
}

const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/iu;

/**
 * Project ids are filesystem paths and git remote identities, not safe Windows path segments.
 * Keep the existing POSIX layout, but encode Windows-invalid segments before joining them below
 * the artifact root. The same mapping is used for content and project cleanup paths.
 */
function artifactProjectDirectory(root: string, projectId: string): string {
  const segments =
    process.platform === "win32"
      ? projectId
          .split(/[\\/]+/u)
          .filter(Boolean)
          .map(encodeWindowsPathSegment)
      : [projectId];
  return path.join(root, ...(segments.length > 0 ? segments : ["%00"]));
}

function encodeWindowsPathSegment(segment: string): string {
  const encoded = encodeURIComponent(segment)
    .replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`)
    .replace(/\.+$/u, (dots) => "%2E".repeat(dots.length));
  return WINDOWS_RESERVED_SEGMENT.test(segment) || segment === "." || segment === ".."
    ? `%${encoded}`
    : encoded || "%00";
}

export class ArtifactStore extends FileBackedRegistry<PersistedArtifactRecord> {
  private readonly root: string;
  private readonly limits: ArtifactLimits;
  private readonly changeListeners = new Set<(projectId: string) => void>();

  constructor(root: string, logger: Logger, limits?: Partial<ArtifactLimits>) {
    super({
      filePath: path.join(root, "index.json"),
      logger,
      schema: PersistedArtifactRecordSchema,
      getId: (record) => record.artifactId,
      component: "artifact-store",
      module: "artifacts",
    });
    this.root = root;
    this.limits = {
      maxPerProject: limits?.maxPerProject ?? ARTIFACT_MAX_PER_PROJECT,
      maxBytesPerProject: limits?.maxBytesPerProject ?? ARTIFACT_MAX_BYTES_PER_PROJECT,
    };
  }

  /**
   * Fired whenever a project's artifact list changes. Publishes arrive from the agent runtime,
   * which has no session of its own, so the daemon broadcasts the invalidation from here.
   */
  subscribeToChanges(listener: (projectId: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChanged(projectId: string): void {
    for (const listener of this.changeListeners) {
      try {
        listener(projectId);
      } catch (error) {
        this.logger.error({ err: error, projectId }, "Artifact change listener failed");
      }
    }
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    await this.sweepOrphans();
  }

  async listForProject(projectId: string): Promise<PersistedArtifactRecord[]> {
    const records = await this.list();
    return records
      .filter((record) => record.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Reads the bytes a specific record names.
   *
   * Takes the record rather than an id so that whatever a caller advertised — size, digest —
   * describes the bytes it goes on to send. Re-reading the record here would let an overwrite
   * land in between and stream the new document under the old digest.
   */
  async readContent(record: PersistedArtifactRecord): Promise<Buffer> {
    const target = this.contentPath(record);
    if (!target) {
      throw new ArtifactError(
        "artifact_has_no_content",
        `Artifact ${record.artifactId} is a link, not a stored document`,
      );
    }
    try {
      return await fs.readFile(target);
    } catch {
      throw new ArtifactError(
        "artifact_not_found",
        `Artifact ${record.artifactId} has no stored content`,
      );
    }
  }

  async publish(input: PublishArtifactInput): Promise<PublishArtifactResult> {
    const html =
      input.html === undefined || input.html === null ? null : Buffer.from(input.html, "utf8");
    if (html && html.byteLength > ARTIFACT_MAX_BYTES) {
      throw new ArtifactError(
        "artifact_too_large",
        `Artifact is ${html.byteLength} bytes, over the ${ARTIFACT_MAX_BYTES} byte limit`,
      );
    }
    const title = normalizeTitle(input.title);
    const externalUrl = normalizeExternalUrl(input.externalUrl);
    // A row with neither bytes nor a destination is a title that does nothing.
    if (!html && !externalUrl) {
      throw new ArtifactError(
        "artifact_has_no_content",
        "An artifact needs either a document or an external URL",
      );
    }
    const callId = input.origin.callId ?? null;

    let pending: PersistedArtifactRecord | null = null;
    const committed = await this.mutateCache<CommittedPublish>(
      (records) => {
        const now = nextStamp(records);
        const target = this.resolveTarget(records, input, callId, externalUrl);
        // Carried forward digest and all, which is also what keeps the unlink below off its file:
        // the superseded record and this one name the same content.
        const kept = !html && input.keepExistingContent && target?.contentSha256 ? target : null;
        const record: PersistedArtifactRecord = {
          artifactId: target?.artifactId ?? generateArtifactId(),
          projectId: input.projectId,
          title,
          mimeType: ARTIFACT_MIME_TYPE,
          size: html ? html.byteLength : (kept?.size ?? null),
          contentSha256: html
            ? createHash("sha256").update(html).digest("hex")
            : (kept?.contentSha256 ?? null),
          createdAt: target?.createdAt ?? now,
          updatedAt: now,
          pinned: target?.pinned ?? false,
          externalUrl,
          origin: {
            agentId: input.origin.agentId,
            workspaceId: input.origin.workspaceId,
            provider: input.origin.provider,
            callId,
          },
        };
        pending = record;
        records.set(record.artifactId, record);
        const evicted = this.selectEvictions(records, record);
        for (const victim of evicted) records.delete(victim.artifactId);
        return { record, superseded: target, evicted };
      },
      {
        // Durable before the index names it, so a crash here leaves an orphan file the startup
        // sweep reclaims rather than a record pointing at nothing. Nothing is removed in this
        // phase: the path is digest-versioned, so this only ever adds a file, and the record it
        // supersedes keeps its own until the index has committed.
        beforeWrite: async () => {
          if (!pending || !html) return;
          const target = this.contentPath(pending);
          if (!target) return;
          await fs.mkdir(path.dirname(target), { recursive: true });
          await writeFileAtomic(target, html);
        },
      },
    );

    // Past the commit, so every removal below is of something the index no longer names. The
    // superseded version goes only when the new record carries a different digest — republishing
    // identical bytes resolves to the same path, and unlinking it would delete the live file.
    const { record, superseded, evicted } = committed;
    if (superseded && superseded.contentSha256 !== record.contentSha256) {
      await this.unlinkContent(superseded);
    }
    for (const victim of evicted) {
      await this.unlinkContent(victim);
    }
    this.notifyChanged(input.projectId);
    return { record, evictedArtifactIds: evicted.map((victim) => victim.artifactId) };
  }

  /** Leaves `updatedAt` alone: pinning is not a content change and must not reorder the list. */
  async setPinned(artifactId: string, pinned: boolean): Promise<PersistedArtifactRecord | null> {
    const record = await this.update(artifactId, (next) => ({ ...next, pinned }));
    if (record) this.notifyChanged(record.projectId);
    return record;
  }

  async delete(artifactId: string): Promise<boolean> {
    const record = await this.removeIfPresent(artifactId);
    if (!record) return false;
    await this.unlinkContent(record);
    this.notifyChanged(record.projectId);
    return true;
  }

  /**
   * Cascade for project removal. Idempotent and retryable by construction: it re-reads the index
   * each call and treats an already-absent record or file as success.
   *
   * The index mutation is one commit rather than one per record, so a publish cannot interleave
   * and leave its record behind while its file is taken by the directory removal below. A
   * publish landing after the commit keeps both, which is consistent — and the project record
   * only goes once this has returned, so the next attempt collects it.
   */
  async deleteProject(projectId: string): Promise<void> {
    const removed = await this.mutateCache<PersistedArtifactRecord[]>((records) => {
      const victims = [...records.values()].filter((record) => record.projectId === projectId);
      for (const victim of victims) records.delete(victim.artifactId);
      return victims;
    });
    for (const record of removed) {
      await this.unlinkContent(record);
    }
    await fs.rm(artifactProjectDirectory(this.root, projectId), { recursive: true, force: true });
    if (removed.length > 0) this.notifyChanged(projectId);
  }

  /**
   * Versioned by digest, so a record's bytes are immutable once written.
   *
   * An overwrite writes a new file rather than replacing one, which is what makes publish
   * crash-consistent: the index still names the old digest until it commits, and the old file
   * is only unlinked afterwards. Naming by digest alone would let two records share a file and
   * make either one's deletion destroy the other's content, so the id stays in the name.
   */
  contentPath(
    record: Pick<PersistedArtifactRecord, "projectId" | "artifactId" | "contentSha256">,
  ): string | null {
    if (record.contentSha256 === null) return null;
    return path.join(
      artifactProjectDirectory(this.root, record.projectId),
      `${record.artifactId}.${record.contentSha256}.html`,
    );
  }

  private resolveTarget(
    records: ReadonlyMap<string, PersistedArtifactRecord>,
    input: PublishArtifactInput,
    callId: string | null,
    externalUrl: string | null,
  ): PersistedArtifactRecord | null {
    if (input.artifactId) {
      const existing = records.get(input.artifactId);
      if (!existing) {
        throw new ArtifactError("artifact_not_found", `No artifact ${input.artifactId}`);
      }
      this.assertMayOverwrite(existing, input.origin);
      return existing;
    }
    if (callId && input.origin.agentId) {
      // Replay resolves to the record this same tool call already produced.
      for (const candidate of records.values()) {
        if (
          candidate.origin.callId === callId &&
          candidate.origin.agentId === input.origin.agentId
        ) {
          return candidate;
        }
      }
    }
    // A publication to a URL the project already lists updates that artifact instead of adding
    // a second row for one address. This is the Claude edit case: every update of an artifact
    // is a new tool call, so the callId key above never matches, but the destination URL stays
    // the same.
    //
    // Both sides have to be captures, and `origin.callId` is what says so — it is set when a tool
    // result was filed and never by `publish_artifact`. A document an agent published deliberately
    // is therefore neither collapsed into nor swallowed by a URL scraped from tool-result text:
    // its identity is its bytes, and one scraped string must not unlink them.
    if (externalUrl && callId) {
      for (const candidate of records.values()) {
        if (
          candidate.projectId === input.projectId &&
          candidate.origin.callId !== null &&
          candidate.externalUrl === externalUrl
        ) {
          return candidate;
        }
      }
    }
    return null;
  }

  /**
   * Knowing an artifactId must not confer destructive write over a sibling agent's deliverable.
   * Reading is project-wide; overwriting is not.
   */
  private assertMayOverwrite(existing: PersistedArtifactRecord, origin: ArtifactOrigin): void {
    if (existing.origin.agentId === null) return;
    if (existing.origin.agentId === origin.agentId) return;
    throw new ArtifactError(
      "artifact_forbidden",
      `Artifact ${existing.artifactId} belongs to another agent`,
    );
  }

  /**
   * Oldest-first by `updatedAt`, never the record just written, never a pinned one. Ordering by
   * `createdAt` would take a record the user keeps refreshing.
   */
  private selectEvictions(
    records: ReadonlyMap<string, PersistedArtifactRecord>,
    incoming: PersistedArtifactRecord,
  ): PersistedArtifactRecord[] {
    const candidates = Array.from(records.values())
      .filter((record) => record.projectId === incoming.projectId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

    let count = candidates.length;
    let bytes = candidates.reduce((total, record) => total + (record.size ?? 0), 0);
    const evicted: PersistedArtifactRecord[] = [];
    for (const candidate of candidates) {
      if (count <= this.limits.maxPerProject && bytes <= this.limits.maxBytesPerProject) break;
      if (candidate.artifactId === incoming.artifactId) continue;
      if (candidate.pinned) continue;
      evicted.push(candidate);
      count -= 1;
      bytes -= candidate.size ?? 0;
    }
    return evicted;
  }

  private async unlinkContent(record: PersistedArtifactRecord): Promise<void> {
    const target = this.contentPath(record);
    if (!target) return;
    try {
      await fs.rm(target, { force: true });
    } catch (error) {
      this.logger.error(
        { err: error, artifactId: record.artifactId },
        "Failed to remove artifact content",
      );
    }
  }

  /**
   * Reconciles index and disk at startup, against one rule: a record that claims a digest must
   * have its file, and a record that claims none must not.
   *
   * Both halves matter. Dropping a record whose file is gone keeps an unopenable row out of the
   * list; deleting a file no record claims stops an orphan counting against the project quota
   * forever. A link-only record claims no file, so it is not swept — it never had bytes, and
   * the earlier rule of "no file means delete" would have removed every one of them on the
   * first restart.
   */
  private async sweepOrphans(): Promise<void> {
    const records = await this.list();
    const expectedFiles = new Map<string, PersistedArtifactRecord>();
    for (const record of records) {
      const target = this.contentPath(record);
      if (target) expectedFiles.set(target, record);
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }

    const present = new Set<string>();
    for (const entry of entries) {
      // Root-level files are the registry's own bookkeeping — index.json and the temp file an
      // atomic write leaves beside it. Content never sits there: contentPath always puts a file
      // under a projectId, which is never empty.
      if (!entry.isDirectory()) continue;
      for (const full of await storedFiles(path.join(this.root, entry.name))) {
        if (expectedFiles.has(full)) {
          present.add(full);
          continue;
        }
        await fs.rm(full, { force: true });
        this.logger.warn({ path: full }, "Removed orphaned artifact content");
      }
    }

    for (const [contentPath, record] of expectedFiles) {
      if (present.has(contentPath)) continue;
      await this.remove(record.artifactId);
      this.logger.warn(
        { artifactId: record.artifactId },
        "Dropped artifact record with no stored content",
      );
    }
  }
}
