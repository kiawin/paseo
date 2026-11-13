import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const load = () => import("./store.js");
describe("recording recovery", () => {
  it("rejects a media segment over quota without temporary files and allows it after deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-media-quota-"));
    try {
      const { BrowserRecordingStore } = await load();
      const store = new BrowserRecordingStore(root, { maxStorageBytes: 1200 });
      for (const recordingId of ["one", "two"])
        await store.create({ recordingId, workspaceId: "w", startedAt: 1, status: "complete" });
      const segment = {
        streamId: "s",
        segmentId: "a",
        startMs: 0,
        durationMs: 1,
        mimeType: "video/webm",
        bytes: new Uint8Array(400),
      };
      await store.writeMediaSegment("one", segment);
      await expect(store.writeMediaSegment("two", segment)).rejects.toThrow(/quota/i);
      expect(await store.listMediaSegments("two")).toEqual([]);
      await store.delete("one");
      await expect(store.writeMediaSegment("two", segment)).resolves.toBeUndefined();
      expect((await store.listMediaSegments("two")).map((item) => item.segmentId)).toEqual(["a"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("recounts existing recording bytes after a process-style module restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-quota-restart-"));
    try {
      const { BrowserRecordingStore } = await load();
      const initial = new BrowserRecordingStore(root);
      await initial.create({
        recordingId: "r",
        workspaceId: "w",
        startedAt: 1,
        status: "recording",
      });
      const event = {
        recordingId: "r",
        memberId: "m",
        webContentsId: 1,
        frameAttribution: "unattributed" as const,
        kind: "interaction" as const,
        payload: { text: "x".repeat(400) },
      };
      await initial.appendEvent("r", event);
      const used =
        (await readFile(join(root, "r", "metadata.json"))).length +
        (await readFile(join(root, "r", "events.jsonl"))).length;
      vi.resetModules();
      const restarted = new (await load()).BrowserRecordingStore(root, {
        maxStorageBytes: used + 100,
      });
      await expect(restarted.appendEvent("r", event)).rejects.toThrow(/quota/i);
      expect((await restarted.readEvents("r")).events).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("persists interrupted status and failure details even when the quota is full", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-full-status-"));
    try {
      const { BrowserRecordingStore } = await load();
      const initial = new BrowserRecordingStore(root);
      await initial.create({
        recordingId: "r",
        workspaceId: "w",
        startedAt: 1,
        status: "recording",
      });
      const metadataBytes = (await readFile(join(root, "r", "metadata.json"))).length;
      const full = new BrowserRecordingStore(root, { maxStorageBytes: metadataBytes });
      await full.updateMetadata("r", {
        status: "interrupted",
        endedAt: 5,
        captureErrors: ["Recording storage quota exceeded"],
      });
      expect(await full.readMetadata("r")).toMatchObject({
        status: "interrupted",
        endedAt: 5,
        captureErrors: ["Recording storage quota exceeded"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("enforces one quota across concurrent recordings without evicting either", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-concurrent-quota-"));
    try {
      const { BrowserRecordingStore } = await load();
      const first = new BrowserRecordingStore(root, { maxStorageBytes: 1600 });
      const second = new BrowserRecordingStore(root, { maxStorageBytes: 1600 });
      for (const recordingId of ["one", "two"])
        await first.create({ recordingId, workspaceId: "w", startedAt: 1, status: "recording" });
      const results = await Promise.allSettled(
        [first, second].map((store, index) =>
          store.appendEvent(index ? "two" : "one", {
            recordingId: index ? "two" : "one",
            memberId: "m",
            webContentsId: 1,
            frameAttribution: "unattributed",
            kind: "interaction",
            payload: { text: "x".repeat(800) },
          }),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await first.list()).recordings).toHaveLength(2);
      const winner = results[0].status === "fulfilled" ? "one" : "two";
      const remaining = winner === "one" ? "two" : "one";
      await first.delete(winner);
      await expect(
        first.appendEvent(remaining, {
          recordingId: remaining,
          memberId: "m",
          webContentsId: 1,
          frameAttribution: "unattributed",
          kind: "interaction",
          payload: { text: "x".repeat(800) },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("marks an active recording interrupted, seals a torn tail and preserves orphaned data", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-recovery-"));
    try {
      const { BrowserRecordingStore } = await load();
      const store = new BrowserRecordingStore(root);
      await store.create({
        recordingId: "active",
        workspaceId: "w",
        startedAt: 1,
        status: "recording",
      });
      await store.create({
        recordingId: "finished",
        workspaceId: "w",
        startedAt: 2,
        status: "complete",
      });
      const torn = Buffer.from('{"partial":');
      await writeFile(join(root, "active", "events.jsonl"), torn);
      await writeFile(join(root, "active", ".unmatched.tmp"), "recoverable metadata");
      await mkdir(join(root, "active", "media", "stream"), { recursive: true });
      await writeFile(join(root, "active", "media", "stream", ".unmatched.tmp"), "partial media");
      await mkdir(join(root, "orphan"));
      await writeFile(join(root, "orphan", "evidence"), "preserve");
      await store.recover();
      const active = await store.readMetadata("active");
      expect(active.status).toBe("interrupted");
      expect(active.captureErrors).toEqual(
        expect.arrayContaining(["incomplete-event-tail", "unpublished-metadata"]),
      );
      expect(await readFile(join(root, "active", "events.jsonl"))).toEqual(torn);
      expect(await readFile(join(root, "active", ".unmatched.tmp"), "utf8")).toBe(
        "recoverable metadata",
      );
      expect((await store.listMediaSegmentsPage("active", null, 100)).incomplete).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "Interrupted media temporary file remains" }),
        ]),
      );
      expect((await store.readMetadata("finished")).status).toBe("complete");
      expect((await store.list()).incomplete).toContain("orphan");
      expect(await readFile(join(root, "orphan", "evidence"), "utf8")).toBe("preserve");
      await store.delete("orphan");
      expect((await store.list()).incomplete).not.toContain("orphan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("recovers an explicitly deleted tombstone without deleting saved recordings", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-tombstone-"));
    try {
      const { BrowserRecordingStore } = await load();
      const store = new BrowserRecordingStore(root);
      await store.create({
        recordingId: "saved",
        workspaceId: "w",
        startedAt: 1,
        status: "complete",
      });
      const tombstone = ".deleted-gone-12345678-1234-4123-8123-123456789abc";
      await mkdir(join(root, tombstone));
      await writeFile(join(root, tombstone, "data"), "deleted");
      await store.recover();
      expect(await readdir(root)).not.toContain(tombstone);
      expect((await store.readMetadata("saved")).status).toBe("complete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects quota overflow without evicting retained recordings and permits deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-quota-"));
    try {
      const { BrowserRecordingStore } = await load();
      const store = new BrowserRecordingStore(root, { maxStorageBytes: 1024 });
      await store.create({
        recordingId: "saved",
        workspaceId: "w",
        startedAt: 1,
        status: "complete",
      });
      await expect(
        store.appendEvent("saved", {
          recordingId: "saved",
          memberId: "m",
          webContentsId: 1,
          frameAttribution: "unattributed",
          kind: "interaction",
          payload: { text: "x".repeat(2048) },
        }),
      ).rejects.toThrow(/quota/i);
      expect((await store.readMetadata("saved")).status).toBe("complete");
      await store.delete("saved");
      expect((await store.list()).recordings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
