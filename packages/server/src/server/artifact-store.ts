import { createHash, randomBytes } from "node:crypto";
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
  /** Overwrite this record instead of minting one. Requires origin ownership. */
  artifactId?: string | null;
  externalUrl?: string | null;
  origin: ArtifactOrigin;
}

export interface PublishArtifactResult {
  record: PersistedArtifactRecord;
  evictedArtifactIds: string[];
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
 * Bytes live beside the index rather than in it: `<root>/<projectId>/<artifactId>.html`, with
 * `<root>/index.json` holding only metadata. A publish is therefore not one write, so every
 * step that decides or mutates runs inside the inherited mutation queue — quota selection and
 * index commit share one lock, or two concurrent publishes each pick the other as the victim.
 *
 * Ordering is: HTML written and renamed into place, then the index commits, then victim files
 * are unlinked. A crash in either gap leaves an HTML file no record points at, which
 * `sweepOrphans` reclaims at startup — an orphan otherwise counts against the project quota
 * forever.
 */
export interface ArtifactLimits {
  maxPerProject: number;
  maxBytesPerProject: number;
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

  async readContent(artifactId: string): Promise<Buffer> {
    const record = await this.get(artifactId);
    if (!record) throw new ArtifactError("artifact_not_found", `No artifact ${artifactId}`);
    if (record.contentSha256 === null) {
      throw new ArtifactError(
        "artifact_has_no_content",
        `Artifact ${artifactId} is a link, not a stored document`,
      );
    }
    try {
      return await fs.readFile(this.contentPath(record));
    } catch {
      throw new ArtifactError("artifact_not_found", `Artifact ${artifactId} has no stored content`);
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
    const result = await this.mutateCache<PublishArtifactResult>(
      (records) => {
        const now = nextStamp(records);
        const target = this.resolveTarget(records, input, callId);
        const record: PersistedArtifactRecord = {
          artifactId: target?.artifactId ?? generateArtifactId(),
          projectId: input.projectId,
          title,
          mimeType: ARTIFACT_MIME_TYPE,
          size: html ? html.byteLength : null,
          contentSha256: html ? createHash("sha256").update(html).digest("hex") : null,
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
        return { record, evictedArtifactIds: evicted.map((victim) => victim.artifactId) };
      },
      {
        // Durable before the index names it, so a crash here leaves an orphan file the startup
        // sweep reclaims rather than a record pointing at nothing.
        beforeWrite: async () => {
          if (!pending) return;
          const target = this.contentPath(pending);
          if (!html) {
            // Overwriting a stored document with a link drops the bytes here, while the index
            // still names them; a crash before the commit therefore leaves a record whose file
            // is gone, which the sweep treats as corrupt and removes. Losing a superseded
            // document beats leaving a file nothing points at.
            await fs.rm(target, { force: true });
            return;
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          await writeFileAtomic(target, html);
        },
      },
    );

    for (const artifactId of result.evictedArtifactIds) {
      await this.unlinkContent(input.projectId, artifactId);
    }
    this.notifyChanged(input.projectId);
    return result;
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
    await this.unlinkContent(record.projectId, record.artifactId);
    this.notifyChanged(record.projectId);
    return true;
  }

  /**
   * Cascade for project removal. Idempotent and retryable by construction: it re-reads the
   * index each call and treats an already-absent record or file as success, because project
   * removal commits before its listeners run and can be retried after a partial failure.
   */
  async deleteProject(projectId: string): Promise<void> {
    const records = await this.listForProject(projectId);
    for (const record of records) {
      await this.remove(record.artifactId);
    }
    await fs.rm(path.join(this.root, projectId), { recursive: true, force: true });
    if (records.length > 0) this.notifyChanged(projectId);
  }

  contentPath(record: Pick<PersistedArtifactRecord, "projectId" | "artifactId">): string {
    return path.join(this.root, record.projectId, `${record.artifactId}.html`);
  }

  private resolveTarget(
    records: ReadonlyMap<string, PersistedArtifactRecord>,
    input: PublishArtifactInput,
    callId: string | null,
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

  private async unlinkContent(projectId: string, artifactId: string): Promise<void> {
    const target = this.contentPath({ projectId, artifactId });
    try {
      await fs.rm(target, { force: true });
    } catch (error) {
      this.logger.error({ err: error, artifactId }, "Failed to remove artifact content");
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
    const expectedFiles = new Map(
      records
        .filter((record) => record.contentSha256 !== null)
        .map((record) => [this.contentPath(record), record] as const),
    );

    let projectDirs: string[];
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return;
    }

    const present = new Set<string>();
    for (const projectId of projectDirs) {
      const dir = path.join(this.root, projectId);
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(dir, file);
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
