import { expect, it, vi } from "vitest";
import { readVerifiedSegment } from "./playback";

it("rejects a changed range before giving it to the video decoder", async () => {
  const valid = new TextEncoder().encode("abc");
  let reads = 0;
  const consume = vi.fn();
  const bridge = {
    readMedia: async ({ offset, length }: { offset: number; length: number }) => {
      reads++;
      const bytes = valid.slice(offset, offset + length);
      if (reads === 3) bytes[0] ^= 1;
      return {
        bytes,
        totalBytes: valid.length,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      };
    },
  };
  await expect(
    readVerifiedSegment(
      bridge,
      "recording",
      { streamId: "tab", segmentId: "segment", startMs: 0, durationMs: 1, mimeType: "video/webm" },
      consume,
      2,
    ),
  ).rejects.toThrow("integrity");
  expect(consume).not.toHaveBeenCalled();
});

it("bounds digest bookkeeping when a reader supplies tiny ranges", async () => {
  const consume = vi.fn();
  const bridge = {
    readMedia: async () => ({
      bytes: new Uint8Array([1]),
      totalBytes: 5000,
      sha256: "0".repeat(64),
    }),
  };
  await expect(
    readVerifiedSegment(
      bridge,
      "recording",
      { streamId: "tab", segmentId: "segment", startMs: 0, durationMs: 1, mimeType: "video/webm" },
      consume,
      1024,
    ),
  ).rejects.toThrow("range count");
  expect(consume).not.toHaveBeenCalled();
});
