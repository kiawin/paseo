import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BrowserRecordingStore } from "./store.js";

it("removes recovered tombstones without retaining their quota charge", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-recovery-quota-"));
  try {
    const store = new BrowserRecordingStore(root, { maxStorageBytes: 4096 });
    await store.create({
      recordingId: "first",
      workspaceId: "ws",
      startedAt: 1,
      status: "complete",
    });
    await store.writeMediaSegment("first", {
      streamId: "tab",
      segmentId: "video",
      startMs: 0,
      durationMs: 1,
      mimeType: "video/webm",
      bytes: new Uint8Array(2048),
    });
    const before = await stat(join(root, "first", "media", "tab", "video.bin"));
    expect(before.size).toBe(2048);
    await rename(
      join(root, "first"),
      join(root, ".deleted-first-7b2b7b2b-1111-4111-8111-111111111111"),
    );
    const restarted = new BrowserRecordingStore(root, { maxStorageBytes: 4096 });
    await restarted.recover();
    expect((await readdir(root)).some((name) => name.startsWith(".deleted-"))).toBe(false);
    await restarted.create({
      recordingId: "second",
      workspaceId: "ws",
      startedAt: 2,
      status: "complete",
    });
    await expect(
      restarted.writeMediaSegment("second", {
        streamId: "tab",
        segmentId: "video",
        startMs: 0,
        durationMs: 1,
        mimeType: "video/webm",
        bytes: new Uint8Array(2048),
      }),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
