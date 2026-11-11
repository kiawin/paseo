import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  DesktopRecordingBridge,
  DesktopRecordingMediaSegment,
  DesktopRecordingMetadata,
} from "@/desktop/host";
import type { PreparedRecordingShare, RecordingShareSegment } from "./recording-share";

const CHUNK = 1024 * 1024;
const PART = 16 * 1024 * 1024;
const LIMIT = 1024 * 1024 * 1024;
type Read = (offset: number, length: number) => Promise<Uint8Array>;
function inspectEvent(event: unknown, reasons: Set<string>): void {
  if (!event || typeof event !== "object") return;
  const item = event as { kind?: string; payload?: Record<string, unknown> };
  if (item.kind === "gap") reasons.add("The recording contains capture gaps");
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
    if (media.length > 1024) throw new Error("Recording has too many media segments to share");
  } while (mediaCursor !== null);
  const segments: RecordingShareSegment[] = [];
  const files: Array<{
    name: string;
    parts: string[];
    media?: DesktopRecordingMediaSegment;
    size: number;
    sha256?: string;
  }> = [];
  let total = 0;
  const addFile = async (
    name: string,
    size: number,
    read: Read,
    info?: DesktopRecordingMediaSegment,
    expectedHash?: string,
  ) => {
    if (!Number.isSafeInteger(size) || size < 0 || total + size > LIMIT)
      throw new Error("Recording exceeds the 1 GiB sharing limit");
    total += size;
    const whole = sha256.create();
    const parts: string[] = [];
    for (let offset = 0; offset < size; offset += PART) {
      if (segments.length >= 1023) throw new Error("Recording has too many segments to share");
      const length = Math.min(PART, size - offset);
      const id = `part-${segments.length}`;
      const part = sha256.create();
      for (let current = 0; current < length; ) {
        const count = Math.min(CHUNK, length - current);
        const bytes = await read(offset + current, count);
        if (bytes.length !== count) throw new Error("Recording changed while preparing the share");
        part.update(bytes);
        whole.update(bytes);
        current += count;
      }
      const digest = bytesToHex(part.digest());
      segments.push({
        id,
        size: length,
        sha256: digest,
        read: (start, count) => read(offset + start, count),
      });
      parts.push(id);
    }
    if (expectedHash && bytesToHex(whole.digest()) !== expectedHash)
      throw new Error("Media segment integrity check failed");
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
    JSON.stringify({ format: "paseo-recording-share", version: 1, metadata, completeness, files }),
  );
  if (data.byteLength > PART || total + data.byteLength > LIMIT)
    throw new Error("Recording manifest exceeds the sharing limit");
  segments.unshift({
    id: "recording",
    size: data.byteLength,
    sha256: bytesToHex(sha256(data)),
    read: async (offset, length) => data.slice(offset, offset + length),
  });
  return { recordingId, completeness, segments };
}
