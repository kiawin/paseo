import { useSessionStore } from "@/stores/session-store";
import type { RecordingShareDestination } from "./recording-share";

export function resolveRecordingShareDestination(serverId: string): RecordingShareDestination {
  const session = useSessionStore.getState().sessions[serverId];
  const client = session?.client;
  if (!client?.isConnected || client.getLastServerInfoMessage()?.features?.recordingShare !== true)
    throw new Error("recording-share-host-unavailable");
  return {
    begin: (input) => client.beginRecordingShare(input),
    upload: (shareId, segment) =>
      client.uploadRecordingShareSegment({
        shareId,
        segmentId: segment.id,
        size: segment.size,
        read: segment.read,
      }),
    complete: (shareId) => client.completeRecordingShare(shareId),
    delete: (shareId, agentId) => client.deleteRecordingShare(shareId, agentId),
  };
}
