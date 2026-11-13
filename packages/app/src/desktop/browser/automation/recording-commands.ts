import type { DesktopRecordingBridge } from "@/desktop/host";
import {
  createRecordingShare,
  type RecordingShareCompleteness,
  type RecordingShareDestination,
} from "@/attachments/recording-share";
import { resolveRecordingShareDestination } from "@/attachments/recording-share-destination";
import { prepareRecordingShare } from "@/attachments/recording-share-source";

export interface AgentRecordingCaller {
  serverId: string;
  agentId: string;
  workspaceId: string;
}

export interface AgentRecordingStopResult {
  recordingId: string;
  status: "complete" | "interrupted";
  complete: boolean;
  gaps: string[];
}

export interface AgentRecordingCommands {
  start(input: {
    bridge: DesktopRecordingBridge;
    caller: AgentRecordingCaller;
    browserId: string;
    audio: boolean;
  }): Promise<{ recordingId: string }>;
  stop(input: {
    bridge: DesktopRecordingBridge;
    caller: AgentRecordingCaller;
    browserId: string;
  }): Promise<AgentRecordingStopResult>;
}

// Read by the automation handler's error normalizer, which keeps `browser_*` codes.
class AgentRecordingDeniedError extends Error {
  public readonly code = "browser_denied";
}

export function createAgentRecordingCommands(deps: {
  resolveDestination: (serverId: string) => RecordingShareDestination;
  now: () => number;
}): AgentRecordingCommands {
  // The desktop main process records which agent started a recording, so an
  // agent can stop only its own: never one the person started from the toolbar,
  // nor another agent's. This set only stops two concurrent stops copying twice.
  const stopping = new Set<string>();

  return {
    async start({ bridge, caller, browserId, audio }) {
      const agent = { serverId: caller.serverId, agentId: caller.agentId };
      const { recordingId } = await bridge.start({ browserId, agent, ...(audio ? { audio } : {}) });
      return { recordingId };
    },

    async stop({ bridge, caller, browserId }) {
      const active = await bridge.active({ browserId });
      if (!active) throw new AgentRecordingDeniedError(`No recording is active on ${browserId}.`);
      if (active.agent?.serverId !== caller.serverId || active.agent.agentId !== caller.agentId)
        throw new AgentRecordingDeniedError(
          "This agent did not start the recording on this tab. Stop it from the browser toolbar.",
        );
      const { recordingId } = active;
      if (stopping.has(recordingId))
        throw new AgentRecordingDeniedError(`Recording ${recordingId} is already stopping.`);
      stopping.add(recordingId);
      try {
        return await stopAndShare(bridge, caller, recordingId);
      } finally {
        stopping.delete(recordingId);
      }
    },
  };

  async function stopAndShare(
    bridge: DesktopRecordingBridge,
    caller: AgentRecordingCaller,
    recordingId: string,
  ): Promise<AgentRecordingStopResult> {
    await bridge.stop({ recordingId });

    const { recordings } = await bridge.list({ workspaceId: caller.workspaceId });
    const metadata = recordings.find((recording) => recording.recordingId === recordingId);
    if (!metadata) throw new Error(`Recording ${recordingId} was not found after stopping.`);

    let markBegun!: (completeness: RecordingShareCompleteness) => void;
    const begun = new Promise<RecordingShareCompleteness>((resolve) => {
      markBegun = resolve;
    });
    const share = createRecordingShare({
      source: { prepare: () => prepareRecordingShare(bridge, metadata) },
      resolveDestination: deps.resolveDestination,
      // Enabling browser tools on the host is the consent for agent recording.
      confirm: async () => true,
      reserve: (entry) => bridge.changeShareAudit({ recordingId: entry.recordingId, entry }),
      audit: (entry) => bridge.changeShareAudit({ recordingId: entry.recordingId, entry }),
      unreserve: (id, shareId) =>
        bridge.changeShareAudit({ recordingId: id, removeShareId: shareId }),
      // The destination daemon prompts the agent with the manifest path or the failure.
      notifyRecipient: true,
      begun: (completeness) => markBegun(completeness),
      handoff: async () => {},
      now: deps.now,
    });
    const copy = share({
      recordingId,
      serverId: caller.serverId,
      agentId: caller.agentId,
      agentName: caller.agentId,
    });
    // Return once the upload starts. A later failure reaches the agent from the daemon.
    void copy.catch((error: unknown) =>
      console.warn("[browser-recording] agent copy failed", recordingId, error),
    );
    const outcome = await Promise.race([
      begun.then((completeness) => ({ completeness })),
      copy.then(
        () => ({ completeness: null }),
        (error: unknown) => ({ error }),
      ),
    ]);
    if ("error" in outcome) {
      const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      throw new Error(
        `Recording ${recordingId} stopped, but copying it to this host failed: ${reason}. Share it from Recordings in the desktop app.`,
        { cause: outcome.error },
      );
    }
    if (!outcome.completeness)
      throw new Error(`Recording ${recordingId} was not copied to this host.`);
    return {
      recordingId,
      status: metadata.status === "complete" ? "complete" : "interrupted",
      complete: outcome.completeness.complete,
      gaps: outcome.completeness.reasons,
    };
  }
}

export const agentRecordingCommands = createAgentRecordingCommands({
  resolveDestination: resolveRecordingShareDestination,
  now: Date.now,
});
