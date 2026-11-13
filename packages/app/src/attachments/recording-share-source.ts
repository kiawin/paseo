import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  DesktopRecordingBridge,
  DesktopRecordingMediaSegment,
  DesktopRecordingMetadata,
} from "@/desktop/host";
import type { PreparedRecordingShare } from "./recording-share";
import {
  createRecordingPacker,
  type RecordingFilePart,
  type RecordingFileReader,
} from "./recording-share-pack";

const PART = 16 * 1024 * 1024;
const LIMIT = 1024 * 1024 * 1024;
type Read = RecordingFileReader;
function inspectEvent(event: unknown, reasons: Set<string>): void {
  if (!event || typeof event !== "object") return;
  const item = event as { kind?: string; payload?: Record<string, unknown> };
  if (item.kind === "gap") reasons.add("The recording contains capture gaps");
  if (item.kind === "navigation" && item.payload?.urlTruncated === true)
    reasons.add("A navigation URL was truncated");
  if (item.kind !== "network") return;
  for (const field of ["request", "response"]) {
    const value = item.payload?.[field] as { body?: { state?: string } } | null | undefined;
    if (
      value?.body?.state &&
      ["unavailable", "truncated", "unsupported"].includes(value.body.state)
    )
      reasons.add("Some network bodies are incomplete");
  }
}
async function collectEventGaps(
  bridge: DesktopRecordingBridge,
  recordingId: string,
  reasons: Set<string>,
): Promise<void> {
  let cursor: number | null = 0;
  do {
    const page = await bridge.readEvents({ recordingId, cursor, maxBytes: 256 * 1024 });
    if (page.incompleteTail) reasons.add("The event log has an incomplete tail");
    for (const event of page.events) inspectEvent(event, reasons);
    if (page.nextCursor !== null && page.nextCursor <= cursor)
      throw new Error("Event cursor did not advance");
    cursor = page.nextCursor;
  } while (cursor !== null);
}
export async function prepareRecordingShare(
  bridge: DesktopRecordingBridge,
  metadata: DesktopRecordingMetadata,
): Promise<PreparedRecordingShare> {
  if (metadata.status === "recording") throw new Error("Stop recording before sharing");
  const recordingId = metadata.recordingId;
  const reasons = new Set<string>([
    ...(metadata.captureErrors ?? []),
    ...(metadata.recoveryWarnings ?? []),
  ]);
  if (metadata.status === "interrupted") reasons.add("Recording was interrupted");
  if (metadata.audioRequested && metadata.audioStatus !== "captured")
    reasons.add("Requested audio was unavailable or interrupted");
  await collectEventGaps(bridge, recordingId, reasons);
  const media: DesktopRecordingMediaSegment[] = [];
  let mediaCursor: string | null = null;
  do {
    const page = await bridge.listMedia({ recordingId, cursor: mediaCursor, limit: 100 });
    if (page.pending) throw new Error("Recording is still finalizing");
    if (page.incomplete.length) reasons.add("Some media segments are incomplete");
    media.push(...page.segments);
    if (page.nextCursor && page.nextCursor === mediaCursor)
      throw new Error("Media cursor did not advance");
    mediaCursor = page.nextCursor;
    if (media.length > 100_000) throw new Error("Recording has too many media files to share");
  } while (mediaCursor !== null);
  const packer = createRecordingPacker();
  const files: Array<{
    name: string;
    parts: RecordingFilePart[];
    media?: DesktopRecordingMediaSegment;
    size: number;
    sha256?: string;
  }> = [];
  const addFile = async (
    name: string,
    size: number,
    read: Read,
    info?: DesktopRecordingMediaSegment,
    expectedHash?: string,
  ) => {
    const parts = await packer.addFile(size, read, expectedHash);
    files.push({
      name,
      parts,
      size,
      ...(info ? { media: info } : {}),
      ...(expectedHash ? { sha256: expectedHash } : {}),
    });
  };
  const first = await bridge.readExportEvents({ recordingId, offset: 0, length: 1 });
  const eventRead: Read = async (offset, length) => {
    const page = await bridge.readExportEvents({ recordingId, offset, length });
    if (page.totalBytes !== first.totalBytes) throw new Error("Event log changed while sharing");
    return page.bytes;
  };
  await addFile("events.jsonl", first.totalBytes, eventRead);
  for (const info of media) {
    const firstPage = await bridge.readMedia({
      recordingId,
      streamId: info.streamId,
      segmentId: info.segmentId,
      offset: 0,
      length: 1,
    });
    const read: Read = async (offset, length) => {
      const page = await bridge.readMedia({
        recordingId,
        streamId: info.streamId,
        segmentId: info.segmentId,
        offset,
        length,
      });
      if (page.totalBytes !== firstPage.totalBytes || page.sha256 !== firstPage.sha256)
        throw new Error("Media segment changed while sharing");
      return page.bytes;
    };
    await addFile(
      `media/${info.streamId}/${info.segmentId}.bin`,
      firstPage.totalBytes,
      read,
      info,
      firstPage.sha256,
    );
  }
  const allReasons = [...reasons];
  const disclosedReasons =
    allReasons.length > 100
      ? [
          ...allReasons.slice(0, 99),
          "Additional capture problems are listed in the recording metadata",
        ]
      : allReasons;
  const completeness = { complete: reasons.size === 0, reasons: disclosedReasons };
  const data = new TextEncoder().encode(
    JSON.stringify({ format: "paseo-recording-share", version: 2, metadata, completeness, files }),
  );
  if (data.byteLength > PART || packer.totalBytes() + data.byteLength > LIMIT)
    throw new Error("Recording manifest exceeds the sharing limit");
  const segments = packer.finish();
  segments.unshift({
    id: "recording",
    size: data.byteLength,
    sha256: bytesToHex(sha256(data)),
    read: async (offset, length) => data.slice(offset, offset + length),
  });
  return { recordingId, completeness, segments };
}
