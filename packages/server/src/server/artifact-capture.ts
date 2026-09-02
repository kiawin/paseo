import type { Logger } from "pino";

import type { ArtifactStore } from "./artifact-store.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

export interface ExternalArtifactPublication {
  agentId: string;
  workspaceId: string;
  provider: string;
  callId: string;
  url: string;
  title: string | null;
}

/**
 * A row needs a name. The host is the useful one when the tool reported no title; the raw URL
 * only stands in for a string that is not a URL at all, which the store then refuses anyway.
 */
function resolveTitle(input: ExternalArtifactPublication): string {
  const given = input.title?.trim();
  if (given) return given;
  try {
    return new URL(input.url).hostname || input.url;
  } catch {
    return input.url;
  }
}

/**
 * Files a document an agent published to a URL of its own as a link-only artifact.
 *
 * Link-only, never a copy, even when the agent handed the tool a local file. A published page
 * can depend on the origin it was published to — Claude's artifacts may declare runtime
 * capabilities and reference uploaded assets — so a snapshot in Paseo's sandbox would look
 * right and silently not work. The live page stays canonical; an agent that wants a document
 * Paseo actually holds calls `publish_artifact` with the HTML.
 *
 * Publication is keyed on `(agentId, callId)` inside the store, so this is safe to call from a
 * path that also runs on history replay: a replayed tool result resolves to the record it
 * already produced instead of adding another.
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
      await deps.artifactStore.publish({
        projectId: workspace.projectId,
        title: resolveTitle(input),
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
