import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ mode: "none" as "none" | "event" | "metadata" | "scan" }));
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      if (fault.mode === "scan" && String(args[0]).endsWith("unreadable"))
        throw Object.assign(new Error("scan denied"), { code: "EACCES" });
      return actual.opendir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      if (
        !(
          (fault.mode === "event" && path.endsWith("events.jsonl")) ||
          (fault.mode === "metadata" && path.endsWith(".tmp"))
        )
      )
        return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile")
            return async () => {
              throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
describe("disk-full recording writes", () => {
  it("allows essential metadata and deletion when a different directory prevents quota scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-scan-error-"));
    try {
      const { BrowserRecordingStore } = await import("./store.js");
      const initial = new BrowserRecordingStore(root);
      await initial.create({
        recordingId: "r",
        workspaceId: "w",
        startedAt: 1,
        status: "recording",
      });
      await mkdir(join(root, "unreadable"));
      vi.resetModules();
      const store = new (await import("./store.js")).BrowserRecordingStore(root);
      fault.mode = "scan";
      await store.updateMetadata("r", { status: "interrupted" });
      expect((await store.readMetadata("r")).status).toBe("interrupted");
      await expect(store.delete("r")).resolves.toBeUndefined();
    } finally {
      fault.mode = "none";
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not charge cleanly rolled-back metadata or media failures against quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-quota-rollback-"));
    try {
      const { BrowserRecordingStore } = await import("./store.js");
      const store = new BrowserRecordingStore(root, { maxStorageBytes: 1000 });
      await store.create({ recordingId: "r", workspaceId: "w", startedAt: 1, status: "recording" });
      const segment = {
        streamId: "s",
        segmentId: "first",
        startMs: 0,
        durationMs: 1,
        mimeType: "video/webm",
        bytes: new Uint8Array(100),
      };
      fault.mode = "metadata";
      for (let index = 0; index < 5; index++) {
        await expect(store.updateMetadata("r", { status: "interrupted" })).rejects.toMatchObject({
          code: "ENOSPC",
        });
        await expect(
          store.writeMediaSegment("r", { ...segment, segmentId: `failed${index}` }),
        ).rejects.toMatchObject({ code: "ENOSPC" });
      }
      fault.mode = "none";
      await expect(
        store.writeMediaSegment("r", { ...segment, segmentId: "fresh" }),
      ).resolves.toBeUndefined();
    } finally {
      fault.mode = "none";
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reports media ENOSPC and accepts a fresh segment ID after space returns", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-media-enospc-"));
    try {
      const { BrowserRecordingStore } = await import("./store.js");
      const store = new BrowserRecordingStore(root);
      await store.create({ recordingId: "r", workspaceId: "w", startedAt: 1, status: "recording" });
      const segment = {
        streamId: "s",
        segmentId: "first",
        startMs: 0,
        durationMs: 1,
        mimeType: "video/webm",
        bytes: new Uint8Array([1, 2, 3]),
      };
      fault.mode = "metadata";
      await expect(store.writeMediaSegment("r", segment)).rejects.toMatchObject({ code: "ENOSPC" });
      fault.mode = "none";
      await store.writeMediaSegment("r", { ...segment, segmentId: "fresh" });
      expect((await store.listMediaSegments("r")).map((item) => item.segmentId)).toEqual(["fresh"]);
    } finally {
      fault.mode = "none";
      await rm(root, { recursive: true, force: true });
    }
  });
  it("shows interrupted status even when recovery cannot write metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-recovery-enospc-"));
    try {
      const { BrowserRecordingStore } = await import("./store.js");
      const store = new BrowserRecordingStore(root);
      await store.create({ recordingId: "r", workspaceId: "w", startedAt: 1, status: "recording" });
      fault.mode = "metadata";
      await expect(store.recover()).rejects.toThrow("could not save metadata");
      const listing = await store.list();
      expect(listing.recordings[0]).toMatchObject({
        status: "interrupted",
        recoveryWarnings: expect.arrayContaining(["recovery-write-failed"]),
      });
      fault.mode = "none";
      await store.recover();
      expect(JSON.parse(await readFile(join(root, "r", "metadata.json"), "utf8")).status).toBe(
        "interrupted",
      );
    } finally {
      fault.mode = "none";
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reports ENOSPC and preserves the prior durable event prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-enospc-"));
    try {
      const { BrowserRecordingStore } = await import("./store.js");
      const store = new BrowserRecordingStore(root);
      await store.create({ recordingId: "r", workspaceId: "w", startedAt: 1, status: "recording" });
      const event = {
        recordingId: "r",
        memberId: "m",
        webContentsId: 1,
        frameAttribution: "unattributed" as const,
        kind: "interaction" as const,
        payload: { value: "first" },
      };
      await store.appendEvent("r", event);
      const path = join(root, "r", "events.jsonl");
      const before = await readFile(path);
      fault.mode = "event";
      await expect(
        store.appendEvent("r", { ...event, payload: { value: "second" } }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
      fault.mode = "none";
      expect(await readFile(path)).toEqual(before);
    } finally {
      fault.mode = "none";
      await rm(root, { recursive: true, force: true });
    }
  });
});
