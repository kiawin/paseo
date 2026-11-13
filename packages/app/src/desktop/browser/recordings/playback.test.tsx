import { describe, expect, it, vi } from "vitest";
const load = () => import("./playback");
const segments = [
  {
    streamId: "root",
    segmentId: "a",
    generationId: "g1",
    sequence: 0,
    startMs: 100,
    durationMs: 1000,
    mimeType: "video/webm",
  },
  {
    streamId: "root",
    segmentId: "b",
    generationId: "g1",
    sequence: 1,
    startMs: 1100,
    durationMs: 1000,
    mimeType: "video/webm",
  },
  {
    streamId: "popup",
    segmentId: "c",
    generationId: "g2",
    sequence: 0,
    startMs: 300,
    durationMs: 1000,
    mimeType: "video/webm",
  },
];
describe("recording playback", () => {
  it("keeps a generation continuous across chunk boundaries and marks gaps between generations", async () => {
    const { createPlayback } = await load();
    const player = createPlayback([
      { ...segments[0], durationMs: 999.9 },
      segments[1],
      { ...segments[2], streamId: "root", startMs: 2500, durationMs: 500 },
    ]);
    player.select("root");
    player.seek(1099.95);
    expect(player.getState().available).toBe(true);
    expect(player.ranges("root", 3200)).toEqual([
      { startMs: 0, endMs: 100, available: false },
      { startMs: 100, endMs: 2100, available: true },
      { startMs: 2100, endMs: 2500, available: false },
      { startMs: 2500, endMs: 3000, available: true },
      { startMs: 3000, endMs: 3200, available: false },
    ]);
  });
  it("seeks by event time and retains the clock when changing views", async () => {
    const { createPlayback } = await load();
    const player = createPlayback(segments);
    player.select("root");
    player.seekEvent({ timelineMs: 500 });
    expect(player.getState()).toMatchObject({ streamId: "root", timeMs: 500, available: true });
    player.select("popup");
    expect(player.getState()).toMatchObject({ streamId: "popup", timeMs: 500, available: true });
    player.seek(2000);
    expect(player.getState()).toMatchObject({ timeMs: 2000, available: false });
  });
  it("groups all chunks of the selected generation in sequence order", async () => {
    const { createPlayback } = await load();
    const player = createPlayback([segments[1], segments[2], segments[0]]);
    player.select("root");
    player.seek(1500);
    expect(player.getState().generation?.segments.map((s) => s.segmentId)).toEqual(["a", "b"]);
  });
  it("reads media in bounded ranges and verifies its digest", async () => {
    const { readVerifiedSegment } = await load();
    const bytes = new TextEncoder().encode("abc");
    const readMedia = vi.fn(async ({ offset, length }: { offset: number; length: number }) => ({
      bytes: bytes.slice(offset, offset + length),
      totalBytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    }));
    const collected: number[] = [];
    await readVerifiedSegment(
      { readMedia },
      "r",
      segments[0],
      (chunk) => {
        collected.push(...chunk);
      },
      2,
    );
    expect(readMedia).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, length: 2 }));
    expect(readMedia).toHaveBeenCalledWith(expect.objectContaining({ offset: 2, length: 2 }));
    expect(collected).toEqual([97, 98, 99]);
    await expect(
      readVerifiedSegment(
        {
          readMedia: async () => ({
            bytes: new Uint8Array([1]),
            totalBytes: 1,
            sha256: "0".repeat(64),
          }),
        },
        "r",
        segments[0],
        () => {},
        2,
      ),
    ).rejects.toThrow(/integrity/i);
  });
  it("does not seek when event time is unavailable", async () => {
    const { createPlayback } = await load();
    const player = createPlayback(segments);
    player.select("root");
    player.seek(400);
    expect(player.seekEvent({})).toBe(false);
    expect(player.getState().timeMs).toBe(400);
  });
});
