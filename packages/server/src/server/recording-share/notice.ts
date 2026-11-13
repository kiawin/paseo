/** An agent-run copy of a browser recording, waiting to tell its recipient how it ended. */
export interface RecordingShareNotice {
  recipientAgentId: string;
  recordingId: string;
  complete: boolean;
  gaps: string[];
}

/** The prompt for a settled copy: the manifest path, or null when the copy failed. */
export function buildRecordingShareNoticePrompt(
  notice: RecordingShareNotice,
  manifestPath: string | null,
): string {
  if (manifestPath === null)
    return `Browser recording ${notice.recordingId} was not copied to this host: the copy was cancelled or the desktop app disconnected. Ask the person to share it from Recordings in the desktop app.`;
  return [
    `Browser recording ${notice.recordingId} was copied to ${manifestPath}.`,
    "Read the manifest and recording.bin in the same directory. recording.bin describes files as ordered ranges with part ID, byte offset, and length; each part is stored as <part ID>.bin. Concatenate the ranges in order to rebuild each file, and verify the sizes and hashes in the manifest first.",
    notice.complete
      ? "Capture reported no gaps."
      : `Capture is incomplete: ${notice.gaps.join("; ")}.`,
  ].join("\n");
}
