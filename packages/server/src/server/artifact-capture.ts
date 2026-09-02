import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { ARTIFACT_MAX_BYTES, type ArtifactStore } from "./artifact-store.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

export interface ExternalArtifactPublication {
  agentId: string;
  workspaceId: string;
  provider: string;
  callId: string;
  url: string;
  title: string | null;
  /** The document the tool published, when it reported a path. Read for its title and its bytes. */
  filePath?: string | null;
}

/**
 * How much of the document is searched for its `<title>`. claude.ai reads the first 8 KB of a file
 * it publishes and nothing beyond, so a page whose tag sits past that is named by its file instead
 * — matching the window means Paseo's list reads the same as the gallery it mirrors.
 */
const TITLE_SCAN_LENGTH = 8 * 1024;
const TITLE_TAG = /<title[^>]*>([\s\S]*?)<\/title>/i;

/** Enough of the entity table for a title. Anything else stays as it was written. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[lower] ?? whole;
  });
}

function documentTitle(html: string | null): string | null {
  if (!html) return null;
  const text = html.slice(0, TITLE_SCAN_LENGTH).match(TITLE_TAG)?.[1];
  if (!text) return null;
  return decodeEntities(text).replace(/\s+/g, " ").trim() || null;
}

/**
 * Why a publication kept no copy. `no-path` is the tool reporting nothing, which is the ordinary
 * case for a publisher that hands back only a URL; the rest are a document Paseo could have held
 * and did not, and each one is a row that opens the live page instead of local bytes.
 */
type UncopiedReason = "no-path" | "not-html" | "unreadable" | "not-a-file" | "too-large";

interface PublishedDocument {
  html: string | null;
  /** Null when the bytes were read. */
  uncopied: UncopiedReason | null;
}

/**
 * The published document, or the reason there is nothing Paseo can hold.
 *
 * Every rejection lands on the same outcome — a row that is a link and no copy, which is what this
 * feature recorded for every artifact before it kept one. Capture is a courtesy on top of a tool
 * call that already succeeded, so none of them fails the publish; the reason rides back out so the
 * caller can say at debug why a row a person expected to open locally does not.
 */
async function readPublishedDocument(
  filePath: string | null | undefined,
  cwd: string,
): Promise<PublishedDocument> {
  if (!filePath) return { html: null, uncopied: "no-path" };
  // A record's mimeType is `text/html`. A markdown publish stays a link rather than being stored
  // under a type that would render its source as a page.
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".html" && extension !== ".htm") return { html: null, uncopied: "not-html" };
  // The tool reports the path it was handed, and an agent writing into its own working directory
  // hands over a relative one. The daemon's cwd is not the agent's, so resolving against the
  // workspace is the difference between a copy and a silent link-only row.
  const resolved = path.resolve(cwd, filePath);
  try {
    const stats = await fs.stat(resolved);
    // isFile keeps a fifo or a device from blocking the read, and the store's own ceiling is
    // checked here so an oversized page degrades to a link instead of failing the publish.
    if (!stats.isFile()) return { html: null, uncopied: "not-a-file" };
    if (stats.size > ARTIFACT_MAX_BYTES) return { html: null, uncopied: "too-large" };
    return { html: await fs.readFile(resolved, "utf8"), uncopied: null };
  } catch {
    return { html: null, uncopied: "unreadable" };
  }
}

/**
 * A row needs a name, in this order:
 *
 * 1. The document's own `<title>`. It is what the publisher's gallery shows, and the tool that
 *    published it tells agents to name the page there rather than in a parameter.
 * 2. What the tool reported, which for Claude is the file name the adapter fell back to.
 * 3. The host, which only stands in when there was no file to read either — and the raw URL when
 *    it is not a URL at all, which the store then refuses anyway.
 */
function resolveTitle(input: ExternalArtifactPublication, html: string | null): string {
  const fromDocument = documentTitle(html);
  if (fromDocument) return fromDocument;
  const given = input.title?.trim();
  if (given) return given;
  try {
    return new URL(input.url).hostname || input.url;
  } catch {
    return input.url;
  }
}

/**
 * Files a document an agent published to a URL of its own, keeping both the address and a copy.
 *
 * The copy is the file the tool was handed, read from disk here rather than fetched: the live page
 * sits behind the publisher's login, which the daemon does not hold. It is a snapshot and says so
 * — the row keeps its `externalUrl`, and a page that depends on the origin it was published to
 * (Claude's runtime capabilities, `_blob/` assets) is one tap from the live version that works.
 *
 * Publication is keyed on `(agentId, callId)` inside the store, so this is safe to call from a
 * path that also runs on history replay: a replayed tool result resolves to the record it
 * already produced instead of adding another. Replay is also why the publish keeps existing
 * content — by then the scratch file the copy came from is usually gone, and a re-file with
 * nothing to read must not strip the bytes off a record that has them.
 */
export function createExternalArtifactRecorder(deps: {
  artifactStore: Pick<ArtifactStore, "publish">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  logger: Logger;
}): (input: ExternalArtifactPublication) => Promise<void> {
  const logger = deps.logger.child({ module: "artifacts", component: "external-capture" });

  // Returns a promise that never rejects. The caller is a stream dispatch that must not wait or
  // fail, and discards it; returning it anyway means a test can await the work instead of
  // sleeping past filesystem I/O it cannot time.
  return async (input) => {
    try {
      const workspace = await deps.workspaceRegistry.get(input.workspaceId);
      if (!workspace) return;
      const { html, uncopied } = await readPublishedDocument(input.filePath, workspace.cwd);
      if (uncopied && uncopied !== "no-path") {
        logger.debug(
          { agentId: input.agentId, url: input.url, filePath: input.filePath, reason: uncopied },
          "Published artifact kept no copy",
        );
      }
      await deps.artifactStore.publish({
        projectId: workspace.projectId,
        title: resolveTitle(input, html),
        html,
        keepExistingContent: true,
        externalUrl: input.url,
        origin: {
          agentId: input.agentId,
          workspaceId: workspace.workspaceId,
          provider: input.provider,
          callId: input.callId,
        },
      });
    } catch (error) {
      // Capture is a courtesy on top of a tool call that already succeeded, and the agent is
      // not waiting on it. Failing to file the record must not disturb the turn.
      logger.warn(
        { err: error, agentId: input.agentId, url: input.url },
        "Failed to record a published artifact",
      );
    }
  };
}
