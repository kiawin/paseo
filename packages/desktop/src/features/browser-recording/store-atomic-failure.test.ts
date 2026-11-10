import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failure = vi.hoisted(() => ({
  rename: false,
  open: false,
  sync: false,
  partialAppend: false,
  directorySync: false,
  failSecondLink: false,
  linkCount: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (
      from: Parameters<typeof actual.link>[0],
      to: Parameters<typeof actual.link>[1],
    ) => {
      if (failure.failSecondLink && ++failure.linkCount === 2) {
        failure.failSecondLink = false;
        throw new Error("injected metadata link failure");
      }
      return actual.link(from, to);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      if (failure.open && path.endsWith(".tmp")) {
        failure.open = false;
        throw new Error("injected open failure");
      }
      const handle = await actual.open(...args);
      if (failure.directorySync && path.endsWith("/media/tab")) {
        const original = handle.sync.bind(handle);
        Object.defineProperty(handle, "sync", {
          value: async () => {
            if (failure.directorySync) {
              failure.directorySync = false;
              throw new Error("injected directory sync failure");
            }
            return original();
          },
        });
      }
      if (failure.sync && path.endsWith(".tmp")) {
        const original = handle.sync.bind(handle);
        Object.defineProperty(handle, "sync", {
          value: async () => {
            if (failure.sync) {
              failure.sync = false;
              throw new Error("injected sync failure");
            }
            return original();
          },
        });
      }
      if (failure.partialAppend && path.endsWith("events.jsonl")) {
        failure.partialAppend = false;
        Object.defineProperty(handle, "writeFile", {
          value: async (data: Uint8Array) => {
            const partial = Buffer.from(data).subarray(0, 5);
            await handle.write(partial, 0, partial.length, null);
            throw new Error("injected partial write");
          },
        });
      }
      return handle;
    },
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (failure.rename) {
        failure.rename = false;
        throw new Error("injected rename failure");
      }
      return actual.rename(from, to);
    },
  };
});
import { BrowserRecordingStore } from "./store.js";

let root: string;
beforeEach(async () => {
  failure.rename = false;
  failure.open = false;
  failure.sync = false;
  failure.partialAppend = false;
  failure.directorySync = false;
  failure.failSecondLink = false;
  failure.linkCount = 0;
  root = await mkdtemp(join(tmpdir(), "paseo-recording-failure-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("recording metadata atomic replacement", () => {
  it.skipIf(process.platform === "win32")(
    "preserves a published segment when the final directory sync fails",
    async () => {
      const store = new BrowserRecordingStore(root);
      await store.create({
        recordingId: "recording",
        workspaceId: "workspace",
        startedAt: 1,
        status: "recording",
      });
      const segment = {
        streamId: "tab",
        segmentId: "segment",
        startMs: 0,
        durationMs: 10,
        mimeType: "video/webm",
        bytes: Uint8Array.of(1, 2),
      };
      failure.directorySync = true;
      await expect(store.writeMediaSegment("recording", segment)).rejects.toThrow(
        "injected directory sync failure",
      );
      expect(await store.readMediaSegment("recording", "tab", "segment")).toEqual(segment);
      await expect(store.writeMediaSegment("recording", segment)).rejects.toThrow();
    },
  );
  it("rolls back a failed media metadata publication and permits retry", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create({
      recordingId: "recording",
      workspaceId: "workspace",
      startedAt: 1,
      status: "recording",
    });
    const segment = {
      streamId: "tab",
      segmentId: "segment",
      startMs: 0,
      durationMs: 10,
      mimeType: "video/webm",
      bytes: Uint8Array.of(1, 2),
    };
    failure.failSecondLink = true;
    failure.linkCount = 0;
    await expect(store.writeMediaSegment("recording", segment)).rejects.toThrow(
      "injected metadata link failure",
    );
    expect(await readdir(join(root, "recording", "media", "tab"))).toEqual([]);
    await store.writeMediaSegment("recording", segment);
    expect((await store.readMediaSegment("recording", "tab", "segment")).bytes).toEqual(
      segment.bytes,
    );
  });
  it("preserves the previous metadata when temporary-file creation or sync fails", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create({
      recordingId: "recording",
      workspaceId: "workspace",
      startedAt: 1,
      status: "recording",
    });
    for (const kind of ["open", "sync"] as const) {
      failure[kind] = true;
      await expect(store.updateMetadata("recording", { status: "complete" })).rejects.toThrow(
        `injected ${kind} failure`,
      );
      expect(await store.readMetadata("recording")).toMatchObject({ status: "recording" });
      expect(
        (await readdir(join(root, "recording"))).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    }
  });
  it("rolls back a partial event write so later appends remain possible", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create({
      recordingId: "recording",
      workspaceId: "workspace",
      startedAt: 1,
      status: "recording",
    });
    const event = {
      recordingId: "recording",
      memberId: "member",
      webContentsId: 1,
      kind: "interaction" as const,
      frameAttribution: "unattributed" as const,
      payload: { value: 1 },
    };
    await store.appendEvent("recording", event);
    failure.partialAppend = true;
    await expect(store.appendEvent("recording", event)).rejects.toThrow("injected partial write");
    await store.appendEvent("recording", event);
    expect(await store.readEvents("recording")).toEqual({
      events: [event, event],
      incompleteTail: false,
    });
  });
  it("keeps the previous document and removes its temporary file on rename failure", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create({
      recordingId: "recording",
      workspaceId: "workspace",
      startedAt: 1,
      status: "recording",
    });
    failure.rename = true;
    await expect(store.updateMetadata("recording", { status: "complete" })).rejects.toThrow(
      "injected rename failure",
    );
    expect(await store.readMetadata("recording")).toMatchObject({ status: "recording" });
    expect(
      (await readdir(join(root, "recording"))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
