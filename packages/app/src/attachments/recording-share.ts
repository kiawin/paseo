export interface RecordingShareCompleteness {
  complete: boolean;
  reasons: string[];
}
export interface RecordingShareSegment {
  id: string;
  size: number;
  sha256: string;
  read: (offset: number, length: number) => Promise<Uint8Array>;
}
export interface PreparedRecordingShare {
  recordingId: string;
  completeness: RecordingShareCompleteness;
  segments: RecordingShareSegment[];
}
export interface RecordingShareAudit {
  recordingId: string;
  serverId: string;
  agentId: string;
  shareId: string;
  time: number;
  completeness: RecordingShareCompleteness;
  manifestPath: string;
}
export interface RecordingShareDestination {
  begin(input: {
    recordingId: string;
    recipientAgentId: string;
    manifest: { version: 1; segments: Array<{ id: string; size: number; sha256: string }> };
  }): Promise<string>;
  upload(shareId: string, segment: RecordingShareSegment): Promise<void>;
  complete(shareId: string): Promise<string>;
  delete(shareId: string, agentId: string): Promise<void>;
}
export interface RecordingShareDependencies {
  source: { prepare: (recordingId: string) => Promise<PreparedRecordingShare> };
  resolveDestination: (serverId: string) => RecordingShareDestination;
  confirm: (input: {
    agentName: string;
    containsSecrets: true;
    completeness: RecordingShareCompleteness;
  }) => Promise<boolean>;
  audit: (entry: RecordingShareAudit) => Promise<void>;
  reserve?: (entry: RecordingShareAudit) => Promise<void>;
  unreserve?: (recordingId: string, shareId: string) => Promise<void>;
  handoff: (input: {
    serverId: string;
    agentId: string;
    manifestPath: string;
    completeness: RecordingShareCompleteness;
  }) => Promise<void>;
  now: () => number;
}
function cleanupFailure(
  error: unknown,
  cleanupError: unknown,
  shareId: string,
  serverId: string,
): Error {
  return new AggregateError(
    [error, cleanupError],
    `Recording share ${shareId} on ${serverId} failed and cleanup also failed`,
    { cause: error },
  );
}
export function createRecordingShare(deps: RecordingShareDependencies) {
  return async (input: {
    recordingId: string;
    serverId: string;
    agentId: string;
    agentName: string;
  }): Promise<boolean> => {
    const destination = deps.resolveDestination(input.serverId);
    const prepared = await deps.source.prepare(input.recordingId);
    if (prepared.recordingId !== input.recordingId) throw new Error("Recording identity mismatch");
    if (
      !(await deps.confirm({
        agentName: input.agentName,
        containsSecrets: true,
        completeness: prepared.completeness,
      }))
    )
      return false;
    const shareId = await destination.begin({
      recordingId: input.recordingId,
      recipientAgentId: input.agentId,
      manifest: {
        version: 1,
        segments: prepared.segments.map(({ id, size, sha256 }) => ({ id, size, sha256 })),
      },
    });
    let completed = false;
    let reserved = false;
    const time = deps.now();
    try {
      await deps.reserve?.({
        recordingId: input.recordingId,
        serverId: input.serverId,
        agentId: input.agentId,
        shareId,
        time,
        completeness: prepared.completeness,
        manifestPath: "",
      });
      reserved = deps.reserve !== undefined;
      for (const segment of prepared.segments) await destination.upload(shareId, segment);
      const manifestPath = await destination.complete(shareId);
      completed = true;
      await deps.audit({
        recordingId: input.recordingId,
        serverId: input.serverId,
        agentId: input.agentId,
        shareId,
        time,
        completeness: prepared.completeness,
        manifestPath,
      });
      await deps.handoff({
        serverId: input.serverId,
        agentId: input.agentId,
        manifestPath,
        completeness: prepared.completeness,
      });
      return true;
    } catch (error) {
      if (!completed) {
        try {
          await destination.delete(shareId, input.agentId);
          if (reserved) await deps.unreserve?.(input.recordingId, shareId);
        } catch (cleanupError) {
          throw cleanupFailure(error, cleanupError, shareId, input.serverId);
        }
      }
      throw error;
    }
  };
}

export async function removeRecordingShare(
  entry: RecordingShareAudit,
  resolveDestination: (serverId: string) => RecordingShareDestination,
  removeAudit: (recordingId: string, shareId: string) => Promise<void>,
): Promise<void> {
  await resolveDestination(entry.serverId).delete(entry.shareId, entry.agentId);
  await removeAudit(entry.recordingId, entry.shareId);
}
