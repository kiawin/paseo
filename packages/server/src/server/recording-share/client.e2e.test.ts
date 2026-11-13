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
    expect(Buffer.compare(await readFile(join(dirname(path), "part-0.bin")), bytes)).toBe(0);
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
    expect(Buffer.compare(await readFile(join(dirname(path), "part-0.bin")), bytes)).toBe(0);
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

test("an agent-run copy tells its recipient when the copy completes or is cancelled", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    const recipient = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.staticDir },
      undefined,
      { initialTitle: "QA agent" },
    );
    await client.connect();
    const bytes = Buffer.alloc(1024, 11);
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
    const timelineText = () =>
      JSON.stringify(daemon.daemon.agentManager.getTimeline(recipient.id)).replaceAll("\\\\", "\\");

    const copied = await client.beginRecordingShare({
      recordingId: "rec-copied",
      recipientAgentId: recipient.id,
      manifest,
      notifyRecipient: { complete: false, gaps: ["The recording contains capture gaps"] },
    });
    await client.uploadRecordingShareSegment({
      shareId: copied,
      segmentId: "part-0",
      size: bytes.length,
      read: async (offset, length) => bytes.subarray(offset, offset + length),
    });
    const manifestPath = await client.completeRecordingShare(copied);
    await expect
      .poll(timelineText, { timeout: 15_000 })
      .toContain(`Browser recording rec-copied was copied to ${manifestPath}.`);
    expect(timelineText()).toContain("Capture is incomplete: The recording contains capture gaps.");

    const cancelled = await client.beginRecordingShare({
      recordingId: "rec-cancelled",
      recipientAgentId: recipient.id,
      manifest,
      notifyRecipient: { complete: true, gaps: [] },
    });
    await client.deleteRecordingShare(cancelled, recipient.id);
    await expect
      .poll(timelineText, { timeout: 15_000 })
      .toContain("Browser recording rec-cancelled was not copied to this host");

    const byPerson = await client.beginRecordingShare({
      recordingId: "rec-person",
      recipientAgentId: recipient.id,
      manifest,
    });
    await client.deleteRecordingShare(byPerson, recipient.id);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(timelineText()).not.toContain("rec-person");
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("an agent-run copy tells its recipient when the copying app disconnects", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    const recipient = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.staticDir },
      undefined,
      { initialTitle: "QA agent" },
    );
    await client.connect();
    await client.beginRecordingShare({
      recordingId: "rec-dropped",
      recipientAgentId: recipient.id,
      manifest: { version: 1, segments: [] },
      notifyRecipient: { complete: true, gaps: [] },
    });
    await client.close();
    await expect
      .poll(() => JSON.stringify(daemon.daemon.agentManager.getTimeline(recipient.id)), {
        timeout: 15_000,
      })
      .toContain("Browser recording rec-dropped was not copied to this host");
  } finally {
    await client.close();
    await daemon.close();
  }
}, 30_000);
