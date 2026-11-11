import { createHash } from "node:crypto";
import { createPaseoApi } from "@getpaseo/client";
import { createHostChannelTransport, createHostClient } from "@getpaseo/client/node";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/index.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("client streams a bounded recording share and removes completed and pending copies", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    const recipient = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.staticDir },
      undefined,
      { initialTitle: "Recording recipient" },
    );
    await client.connect();
    const bytes = Buffer.alloc(9 * 1024 * 1024, 37);
    const manifest = {
      version: 1 as const,
      segments: [
        {
          id: "part-0",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    };
    const pending = await client.beginRecordingShare({
      recordingId: "rec-1",
      recipientAgentId: recipient.id,
      manifest,
    });
    await expect(client.deleteRecordingShare(pending, "wrong-recipient")).rejects.toThrow();
    await client.deleteRecordingShare(pending, recipient.id);
    const shareId = await client.beginRecordingShare({
      recordingId: "rec-1",
      recipientAgentId: recipient.id,
      manifest,
    });
    const reads: number[] = [];
    await client.uploadRecordingShareSegment({
      shareId,
      segmentId: "part-0",
      size: bytes.length,
      read: async (offset, length) => {
        reads.push(length);
        return bytes.subarray(offset, offset + length);
      },
    });
    expect(Math.max(...reads)).toBeLessThanOrEqual(256 * 1024);
    const path = await client.completeRecordingShare(shareId);
    expect(await readFile(join(dirname(path), "part-0.bin"))).toEqual(bytes);
    await client.deleteRecordingShare(shareId, recipient.id);
    await client.deleteRecordingShare(shareId, recipient.id);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    const changed = await client.beginRecordingShare({
      recordingId: "rec-1",
      recipientAgentId: recipient.id,
      manifest,
    });
    await expect(
      client.uploadRecordingShareSegment({
        shareId: changed,
        segmentId: "part-0",
        size: bytes.length,
        read: async (_offset, length) => new Uint8Array(length),
      }),
    ).rejects.toThrow("integrity");
    await client.deleteRecordingShare(changed, recipient.id);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 30_000);

test("client streams a recording through the selected remote host", async () => {
  const source = await createTestPaseoDaemon();
  const destination = await createTestPaseoDaemon();
  const origin = createHostClient(`127.0.0.1:${source.port}`, {
    clientId: "recording-origin",
    reconnect: { enabled: false },
  });
  const paseo = createPaseoApi(origin);
  let routed: DaemonClient | undefined;
  try {
    const recipient = await destination.daemon.agentManager.createAgent(
      { provider: "codex", cwd: destination.staticDir },
      undefined,
      { initialTitle: "Remote recipient" },
    );
    await origin.connect();
    await paseo.hosts.add({ connection: `127.0.0.1:${destination.port}` });
    let serverId = "";
    await expect
      .poll(
        async () => {
          const directory = await paseo.hosts.list();
          const host = directory.hosts[0];
          if (host?.status === "online") serverId = host.serverId ?? "";
          return !!serverId;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    routed = new DaemonClient({
      url: "ws://recording-remote/ws",
      clientId: "recording-remote",
      transportFactory: createHostChannelTransport(origin, serverId, "recording-remote", null),
    });
    await routed.connect();
    const bytes = Buffer.alloc(9 * 1024 * 1024, 73);
    const manifest = {
      version: 1 as const,
      segments: [
        {
          id: "part-0",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    };
    const shareId = await routed.beginRecordingShare({
      recordingId: "rec-1",
      recipientAgentId: recipient.id,
      manifest,
    });
    await routed.uploadRecordingShareSegment({
      shareId,
      segmentId: "part-0",
      size: bytes.length,
      read: async (offset, length) => bytes.subarray(offset, offset + length),
    });
    const path = await routed.completeRecordingShare(shareId);
    expect(path).toContain(destination.paseoHome);
    expect(path).not.toContain(source.paseoHome);
    expect(await readFile(join(dirname(path), "part-0.bin"))).toEqual(bytes);
    await routed.deleteRecordingShare(shareId, recipient.id);
  } finally {
    await routed?.close();
    await paseo.dispose();
    await origin.close();
    await destination.close();
    await source.close();
  }
}, 60_000);

test("disconnect reaps a pending share and later cleanup is idempotent", async () => {
  const daemon = await createTestPaseoDaemon();
  const first = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const second = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    const agent = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.staticDir },
      undefined,
      { initialTitle: "Recipient" },
    );
    await first.connect();
    const shareId = await first.beginRecordingShare({
      recordingId: "rec-1",
      recipientAgentId: agent.id,
      manifest: { version: 1, segments: [] },
    });
    await first.close();
    await second.connect();
    await expect
      .poll(
        async () => {
          try {
            await readFile(
              join(daemon.paseoHome, "recording-shares", shareId, "manifest.pending.json"),
            );
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(false);
    await expect(second.deleteRecordingShare(shareId, agent.id)).resolves.toBeUndefined();
  } finally {
    await first.close();
    await second.close();
    await daemon.close();
  }
}, 30_000);
