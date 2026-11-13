import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecordingShareStore } from "./store.js";

describe("recording share recovery", () => {
  it("cleans pending shares on store shutdown before an in-process restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "share-shutdown-"));
    try {
      const store = new RecordingShareStore(home);
      const id = await store.begin(
        {},
        "agent",
        "recording",
        { version: 1, segments: [] },
        new AbortController().signal,
        () => {},
      );
      await store.close();
      await new RecordingShareStore(home).recover();
      expect(await readdir(join(home, "recording-shares"))).not.toContain(id);
      await expect(
        store.begin(
          {},
          "agent",
          "recording",
          { version: 1, segments: [] },
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow("closed");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("preserves an unknown PID namespace even when that PID is not visible locally", async () => {
    const home = await mkdtemp(join(tmpdir(), "share-namespace-"));
    try {
      const root = join(home, "recording-shares");
      await mkdir(root);
      const id = "33333333-3333-4333-8333-333333333333";
      await writeFile(join(root, `.active-${id}-2147483647-unknown`), "");
      await mkdir(join(root, id));
      await writeFile(join(root, id, "data"), "preserve");
      const store = new RecordingShareStore(home);
      await store.recover();
      expect(await readFile(join(root, id, "data"), "utf8")).toBe("preserve");
      const newId = await store.begin(
        {},
        "agent",
        "recording",
        { version: 1, segments: [] },
        new AbortController().signal,
        () => {},
      );
      expect(newId).not.toBe(id);
      await store.cancel(newId);
      await writeFile(join(root, id, "manifest.pending.json"), "{");
      const partialId = await store.begin(
        {},
        "agent",
        "recording",
        { version: 1, segments: [] },
        new AbortController().signal,
        () => {},
      );
      expect(partialId).not.toBe(id);
      await store.cancel(partialId);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("leaves either a complete manifest or no directory when cancellation races completion", async () => {
    const home = await mkdtemp(join(tmpdir(), "share-completion-race-"));
    try {
      const store = new RecordingShareStore(home);
      const source = {};
      for (let index = 0; index < 10; index++) {
        const id = await store.begin(
          source,
          "agent",
          "recording",
          { version: 1, segments: [] },
          new AbortController().signal,
          () => {},
        );
        await Promise.allSettled([store.complete(source, id), store.cancel(id)]);
        const root = join(home, "recording-shares");
        if ((await readdir(root)).includes(id))
          expect(await readFile(join(root, id, "manifest.json"), "utf8")).toContain("agent");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("preserves a live share owned by another store in the same process", async () => {
    const home = await mkdtemp(join(tmpdir(), "share-recovery-"));
    try {
      const first = new RecordingShareStore(home);
      const second = new RecordingShareStore(home);
      const source = {};
      const id = await first.begin(
        source,
        "agent",
        "recording",
        { version: 1, segments: [] },
        new AbortController().signal,
        () => {},
      );
      await second.recover();
      expect(
        await readFile(join(home, "recording-shares", id, "manifest.pending.json"), "utf8"),
      ).toContain("agent");
      await first.cancel(id);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("preserves a live foreign process and reaps its staging after that process exits", async () => {
    const home = await mkdtemp(join(tmpdir(), "share-foreign-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      const root = join(home, "recording-shares");
      await mkdir(root);
      const id = "12345678-1234-4123-8123-123456789abc";
      const namespace =
        process.platform === "linux"
          ? `ns${(await readlink("/proc/self/ns/pid")).match(/\d+/)?.[0]}`
          : "host";
      await writeFile(join(root, `.active-${id}-${child.pid}-${namespace}`), "");
      await mkdir(join(root, id));
      await writeFile(join(root, id, "data"), "in progress");
      const store = new RecordingShareStore(home);
      await store.recover();
      expect(await readFile(join(root, id, "data"), "utf8")).toBe("in progress");
      child.kill();
      await once(child, "exit");
      await store.recover();
      expect(await readdir(root)).not.toContain(id);
    } finally {
      child.kill();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("reaps orphan staging but preserves completed copies", async () => {
    const home = await mkdtemp(join(tmpdir(), "share-orphan-"));
    try {
      const root = join(home, "recording-shares");
      await mkdir(root);
      const orphan = "11111111-1111-4111-8111-111111111111";
      const complete = "22222222-2222-4222-8222-222222222222";
      await mkdir(join(root, orphan));
      await mkdir(join(root, complete));
      await writeFile(join(root, complete, "manifest.json"), "{}");
      await new RecordingShareStore(home).recover();
      expect(await readdir(root)).not.toContain(orphan);
      expect(await readFile(join(root, complete, "manifest.json"), "utf8")).toBe("{}");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
