import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserRecordingStore } from "./store.js";

describe("recording sharing storage", () => {
  it("keeps audit entries with the recording until the shared copy is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-recording-audit-"));
    try {
      const store = new BrowserRecordingStore(root);
      await store.create({
        recordingId: "rec-1",
        workspaceId: "workspace",
        startedAt: 1,
        status: "complete",
      });
      const entry = {
        recordingId: "rec-1",
        serverId: "remote",
        agentId: "agent",
        shareId: "3b62738a-928b-4c1d-ad4a-8714a4d49b6d",
        time: 123,
        completeness: { complete: false, reasons: ["gap"] },
        manifestPath: "/remote/manifest.json",
      };
      await store.changeShareAudit("rec-1", { entry });
      expect(await store.listShareAudit("rec-1")).toEqual([entry]);
      await expect(store.delete("rec-1")).rejects.toThrow("Remove shared copies");
      await store.changeShareAudit("rec-1", { removeShareId: entry.shareId });
      expect(await store.listShareAudit("rec-1")).toEqual([]);
      await store.delete("rec-1");
      await expect(readFile(join(root, "rec-1", "shares.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("exports the exact event bytes in bounded ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-recording-export-"));
    try {
      const store = new BrowserRecordingStore(root);
      await store.create({
        recordingId: "rec-1",
        workspaceId: "workspace",
        startedAt: 1,
        status: "complete",
      });
      await writeFile(join(root, "rec-1", "events.jsonl"), "line one\npartial");
      const first = await store.readExportEvents("rec-1", 0, 5);
      const rest = await store.readExportEvents("rec-1", 5, 100);
      expect(Buffer.concat([first.bytes, rest.bytes]).toString()).toBe("line one\npartial");
      expect(first.totalBytes).toBe(16);
      await expect(store.readExportEvents("rec-1", 0, 1024 * 1024 + 1)).rejects.toThrow(
        "Invalid event range",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("preserves damaged audit bytes until explicitly forgotten and permits deletion afterward", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-corrupt-audit-"));
  try {
    const store = new BrowserRecordingStore(root);
    await store.create({
      recordingId: "rec-1",
      workspaceId: "ws",
      startedAt: 1,
      status: "complete",
    });
    const file = join(root, "rec-1", "shares.json");
    await writeFile(file, "{broken");
    await expect(store.delete("rec-1")).rejects.toThrow();
    await store.forgetCorruptShareAudit("rec-1");
    expect(await store.listShareAudit("rec-1")).toEqual([]);
    const names = await readdir(join(root, "rec-1"));
    const backup = names.find((name) => name.startsWith(".corrupt-shares-"));
    expect(backup).toBeTruthy();
    expect(await readFile(join(root, "rec-1", backup!), "utf8")).toBe("{broken");
    await store.delete("rec-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("forgets an unsafe audit symlink without modifying its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-audit-link-"));
  try {
    const store = new BrowserRecordingStore(root);
    await store.create({
      recordingId: "rec-1",
      workspaceId: "ws",
      startedAt: 1,
      status: "complete",
    });
    const target = join(root, "outside.json");
    await writeFile(target, "outside");
    await symlink(target, join(root, "rec-1", "shares.json"));
    await expect(store.delete("rec-1")).rejects.toThrow();
    await store.forgetCorruptShareAudit("rec-1");
    await store.delete("rec-1");
    expect(await readFile(target, "utf8")).toBe("outside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
