import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DesktopRecordingBridge, DesktopRecordingMetadata } from "@/desktop/host";
import { prepareRecordingShare } from "./recording-share-source";

const metadata: DesktopRecordingMetadata = {
  recordingId: "rec-1",
  workspaceId: "ws",
  startedAt: 1,
  status: "complete",
};
function fixture() {
  const events = new TextEncoder().encode('{"kind":"gap"}\n');
  const media = new Uint8Array(17 * 1024 * 1024).fill(37);
  const digest = bytesToHex(sha256(media));
  const readMedia = vi.fn(async ({ offset, length }: { offset: number; length: number }) => ({
    bytes: media.slice(offset, offset + length),
    totalBytes: media.length,
    sha256: digest,
  }));
  const bridge = {
    readEvents: vi
      .fn()
      .mockResolvedValue({ events: [{ kind: "gap" }], nextCursor: null, incompleteTail: false }),
    listMedia: vi.fn().mockResolvedValue({
      segments: [
        {
          streamId: "stream",
          segmentId: "video",
          startMs: 0,
          durationMs: 1,
          mimeType: "video/webm",
        },
      ],
      incomplete: [],
      nextCursor: null,
      pending: false,
    }),
    readExportEvents: vi.fn(async ({ offset, length }: { offset: number; length: number }) => ({
      bytes: events.slice(offset, offset + length),
      totalBytes: events.length,
    })),
    readMedia,
  } as unknown as DesktopRecordingBridge;
  return { bridge, readMedia, media };
}
describe("recording share source", () => {
  it("streams bounded verified parts and discloses capture gaps", async () => {
    const { bridge, readMedia, media } = fixture();
    const result = await prepareRecordingShare(bridge, metadata);
    expect(result.completeness.complete).toBe(false);
    expect(result.completeness.reasons).toContain("The recording contains capture gaps");
    expect(result.segments.every((part) => part.size <= 16 * 1024 * 1024)).toBe(true);
    const descriptor = result.segments[0];
    const manifest = JSON.parse(
      new TextDecoder().decode(await descriptor.read(0, descriptor.size)),
    );
    const file = manifest.files.find(
      (item: { name: string }) => item.name === "media/stream/video.bin",
    );
    expect(file.parts).toHaveLength(2);
    expect(file.sha256).toBe(bytesToHex(sha256(media)));
    expect(readMedia.mock.calls.every(([arg]) => arg.length <= 1024 * 1024)).toBe(true);
  });
  it("refuses a corrupt media segment", async () => {
    const { bridge, readMedia } = fixture();
    readMedia.mockImplementation(async ({ offset, length }) => ({
      bytes: new Uint8Array(Math.min(length, 17 * 1024 * 1024 - offset)),
      totalBytes: 17 * 1024 * 1024,
      sha256: "a".repeat(64),
    }));
    await expect(prepareRecordingShare(bridge, metadata)).rejects.toThrow("integrity check");
  });
});

it.each(["unavailable", "truncated", "unsupported"])(
  "discloses a %s network body",
  async (state) => {
    const { bridge } = fixture();
    vi.mocked(bridge.listMedia).mockResolvedValue({
      segments: [],
      incomplete: [],
      nextCursor: null,
      pending: false,
    });
    vi.mocked(bridge.readEvents).mockResolvedValue({
      events: [{ kind: "network", payload: { response: { body: { state } } } }],
      nextCursor: null,
      incompleteTail: false,
    });
    const result = await prepareRecordingShare(bridge, metadata);
    expect(result.completeness).toEqual(
      expect.objectContaining({
        complete: false,
        reasons: expect.arrayContaining(["Some network bodies are incomplete"]),
      }),
    );
  },
);
it("discloses torn event tails, incomplete media and requested missing audio", async () => {
  const { bridge } = fixture();
  vi.mocked(bridge.listMedia).mockResolvedValue({
    segments: [],
    incomplete: [{ streamId: "s", segmentId: "v", reason: "missing" }],
    nextCursor: null,
    pending: false,
  });
  vi.mocked(bridge.readEvents).mockResolvedValue({
    events: [],
    nextCursor: null,
    incompleteTail: true,
  });
  const result = await prepareRecordingShare(bridge, {
    ...metadata,
    status: "interrupted",
    audioRequested: true,
    audioStatus: "unavailable",
  });
  expect(result.completeness.reasons).toEqual(
    expect.arrayContaining([
      "The event log has an incomplete tail",
      "Some media segments are incomplete",
      "Requested audio was unavailable or interrupted",
      "Recording was interrupted",
    ]),
  );
});
