import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  stage: "" as "" | "write" | "sync" | "close" | "sync-close",
  syncs: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (!String(args[0]).endsWith("manifest.pending.json")) return file;
      return new Proxy(file, {
        get(target, property) {
          if (property === "writeFile" && fault.stage === "write")
            return async () => {
              throw new Error("manifest write failed");
            };
          if (property === "sync")
            return async () => {
              fault.syncs++;
              if (fault.stage === "sync" || fault.stage === "sync-close")
                throw new Error("manifest sync failed");
              return target.sync();
            };
          if (property === "close")
            return async () => {
              await target.close();
              if (fault.stage === "close" || fault.stage === "sync-close")
                throw new Error("manifest close failed");
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
import { RecordingShareStore } from "./store.js";

afterEach(() => {
  fault.stage = "";
  fault.syncs = 0;
});
it.each(["write", "sync", "close"] as const)(
  "cleans up a share if manifest %s fails",
  async (stage) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-manifest-failure-"));
    const store = new RecordingShareStore(home);
    try {
      fault.stage = stage;
      await expect(
        store.begin(
          {},
          "agent",
          "recording",
          { version: 1, segments: [] },
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow(`manifest ${stage} failed`);
      expect(await readdir(join(home, "recording-shares"))).toEqual([]);
    } finally {
      fault.stage = "";
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
it("preserves both manifest sync and close errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-manifest-two-failures-"));
  const store = new RecordingShareStore(home);
  try {
    fault.stage = "sync-close";
    await expect(
      store.begin(
        {},
        "agent",
        "recording",
        { version: 1, segments: [] },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({
      message: "Recording manifest write and close failed",
      errors: [
        expect.objectContaining({ message: "manifest sync failed" }),
        expect.objectContaining({ message: "manifest close failed" }),
      ],
    });
    expect(await readdir(join(home, "recording-shares"))).toEqual([]);
  } finally {
    fault.stage = "";
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("flushes a writable manifest before publishing a completed share", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-manifest-success-"));
  const store = new RecordingShareStore(home);
  const source = {};
  try {
    const id = await store.begin(
      source,
      "agent",
      "recording",
      { version: 1, segments: [] },
      new AbortController().signal,
      () => {},
    );
    expect(fault.syncs).toBe(1);
    const path = await store.complete(source, id);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      recipientAgentId: "agent",
      recordingId: "recording",
    });
    expect(fault.syncs).toBe(1);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
