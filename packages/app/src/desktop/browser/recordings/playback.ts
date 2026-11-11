import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DesktopRecordingBridge, DesktopRecordingMediaSegment } from "@/desktop/host";

interface Generation {
  streamId: string;
  generationId: string;
  segments: DesktopRecordingMediaSegment[];
  startMs: number;
  endMs: number;
  complete: boolean;
}
interface PlaybackState {
  streamId: string | null;
  timeMs: number;
  available: boolean;
  generation: Generation | null;
}
export function createPlayback(segments: DesktopRecordingMediaSegment[]) {
  const groups = new Map<string, Generation>();
  for (const segment of segments) {
    if (
      !segment.generationId ||
      !Number.isSafeInteger(segment.sequence) ||
      !Number.isFinite(segment.startMs) ||
      !Number.isFinite(segment.durationMs) ||
      segment.durationMs < 0
    )
      continue;
    const key = JSON.stringify([segment.streamId, segment.generationId]);
    let group = groups.get(key);
    if (!group) {
      group = {
        streamId: segment.streamId,
        generationId: segment.generationId,
        segments: [],
        startMs: segment.startMs,
        endMs: segment.startMs + segment.durationMs,
        complete: true,
      };
      groups.set(key, group);
    }
    group.segments.push(segment);
    group.startMs = Math.min(group.startMs, segment.startMs);
    group.endMs = Math.max(group.endMs, segment.startMs + segment.durationMs);
  }
  for (const group of groups.values()) {
    group.segments.sort((a, b) => a.sequence! - b.sequence!);
    group.complete = group.segments.every((segment, index) => segment.sequence === index);
  }
  let streamId: string | null = null;
  let timeMs = 0;
  const getState = (): PlaybackState => {
    const generation =
      [...groups.values()].find(
        (group) =>
          group.streamId === streamId &&
          group.complete &&
          timeMs >= group.startMs &&
          timeMs < group.endMs,
      ) ?? null;
    return { streamId, timeMs, available: generation !== null, generation };
  };
  return {
    getState,
    views: () => [...new Set(segments.map((item) => item.streamId))],
    ranges(id: string, durationMs: number) {
      const spans = [...groups.values()]
        .filter((group) => group.streamId === id && group.complete && group.endMs > group.startMs)
        .sort((a, b) => a.startMs - b.startMs);
      const ranges: Array<{ startMs: number; endMs: number; available: boolean }> = [];
      let end = 0;
      for (const span of spans) {
        if (span.startMs > end)
          ranges.push({ startMs: end, endMs: span.startMs, available: false });
        if (span.endMs > end) {
          ranges.push({ startMs: Math.max(end, span.startMs), endMs: span.endMs, available: true });
          end = span.endMs;
        }
      }
      if (durationMs > end) ranges.push({ startMs: end, endMs: durationMs, available: false });
      return ranges;
    },
    select(id: string) {
      streamId = id;
      return getState();
    },
    seek(time: number) {
      if (Number.isFinite(time)) timeMs = Math.max(0, time);
      return getState();
    },
    seekEvent(event: { timelineMs?: number }) {
      if (!Number.isFinite(event.timelineMs)) return false;
      timeMs = Math.max(0, event.timelineMs!);
      return true;
    },
  };
}

type MediaReader = Pick<DesktopRecordingBridge, "readMedia">;
export async function readVerifiedSegment(
  bridge: MediaReader,
  recordingId: string,
  segment: DesktopRecordingMediaSegment,
  consume: (chunk: Uint8Array) => void | Promise<void>,
  chunkSize = 1024 * 1024,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 1024 * 1024)
    throw new Error("Invalid media range size");
  let expectedSize: number | null = null;
  let expectedHash: string | null = null;
  for (let pass = 0; pass < 2; pass++) {
    const hash = sha256.create();
    let offset = 0;
    do {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const page = await bridge.readMedia({
        recordingId,
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        offset,
        length: chunkSize,
      });
      if (expectedSize === null) {
        expectedSize = page.totalBytes;
        expectedHash = page.sha256;
      }
      if (
        !Number.isSafeInteger(page.totalBytes) ||
        page.totalBytes <= 0 ||
        page.totalBytes > 256 * 1024 * 1024 ||
        page.totalBytes !== expectedSize ||
        page.sha256 !== expectedHash ||
        page.bytes.length === 0 ||
        page.bytes.length > chunkSize ||
        offset + page.bytes.length > page.totalBytes
      )
        throw new Error("Media integrity check failed");
      hash.update(page.bytes);
      if (pass === 1) await consume(page.bytes);
      offset += page.bytes.length;
    } while (offset < expectedSize!);
    if (bytesToHex(hash.digest()) !== expectedHash) throw new Error("Media integrity check failed");
  }
}
