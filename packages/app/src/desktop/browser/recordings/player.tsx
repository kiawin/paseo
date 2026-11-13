import type { DesktopRecordingMediaSegment } from "@/desktop/host";
export interface RecordingSeek {
  timeMs: number;
  streamId: string;
  nonce: number;
}
export interface RecordingPlayerProps {
  recordingId: string;
  segments: DesktopRecordingMediaSegment[];
  hasMore: boolean;
  seek: RecordingSeek | null;
  pending?: boolean;
  durationMs?: number;
}
export function RecordingPlayer(_props: RecordingPlayerProps) {
  return null;
}
