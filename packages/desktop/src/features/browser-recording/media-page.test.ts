import { link, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserRecordingStore } from "./store.js";

describe("recording media page", () => {
  it("uses a stable key cursor and recovers a torn published hardlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-media-cursor-"));
    try {
      const store = new BrowserRecordingStore(root);
      await store.create({
        recordingId: "r",
        workspaceId: "w",
        startedAt: 1,
        status: "interrupted",
      });
      const write = (segmentId: string) =>
        store.writeMediaSegment("r", {
          streamId: "s",
          segmentId,
          startMs: 0,
          durationMs: 1,
          mimeType: "video/webm",
          bytes: new Uint8Array([1]),
        });
      await write("b");
      await write("c");
      const path = join(root, "r", "media", "s");
      const temp = join(path, ".12345678-1234-4123-8123-123456789abc.tmp");
      await link(join(path, "c.bin"), temp);
      const [first, concurrent] = await Promise.all([
        store.listMediaSegmentsPage("r", null, 2),
        store.listMediaSegmentsPage("r", null, 2),
      ]);
      expect(concurrent.incomplete).toEqual([]);
      expect(first.nextCursor).not.toBeNull();
      await write("a");
      const segments = [...first.segments];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await store.listMediaSegmentsPage("r", cursor, 2);
        segments.push(...page.segments);
        cursor = page.nextCursor;
      }
      expect(segments.map((item) => item.segmentId).sort()).toEqual(["b", "c"]);
      expect((await stat(join(path, "c.bin"))).nlink).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("pages bounded results and retains intact segments alongside damaged entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-media-page-"));
    try {
      const store = new BrowserRecordingStore(root);
      await store.create({
        recordingId: "r",
        workspaceId: "w",
        startedAt: 1,
        status: "interrupted",
      });
      for (const segmentId of ["a", "b", "c"]) {
        await store.writeMediaSegment("r", {
          streamId: "s",
          segmentId,
          startMs: 0,
          durationMs: 1,
          mimeType: "video/webm",
          bytes: new Uint8Array([1, 2]),
        });
      }
      await writeFile(join(root, "r", "media", "s", "orphan.bin"), "x");
      let cursor: string | null = null;
      const found: string[] = [];
      const gaps: string[] = [];
      let pages = 0;
      do {
        const page = await store.listMediaSegmentsPage("r", cursor, 2);
        expect(page.segments.length + page.incomplete.length).toBeLessThanOrEqual(2);
        found.push(...page.segments.map((item) => item.segmentId));
        gaps.push(...page.incomplete.map((item) => item.segmentId ?? ""));
        cursor = page.nextCursor;
        expect(++pages).toBeLessThan(10);
      } while (cursor !== null);
      expect(found.sort()).toEqual(["a", "b", "c"]);
      expect(gaps).toContain("orphan");
      await expect(store.listMediaSegmentsPage("r", null, 101)).rejects.toThrow(
        "Invalid media page",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
