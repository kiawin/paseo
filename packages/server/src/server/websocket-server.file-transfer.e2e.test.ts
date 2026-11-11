import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";

const TEST_TIMEOUT_MS = 30_000;
const FILE_SIZE = 8 * 1024 * 1024 + 123;

let daemon: TestPaseoDaemon | undefined;
const temporaryDirectories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await daemon?.close();
  daemon = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "a large file stays ordered, source-scoped, and does not block another socket",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-large-file-transfer-"));
    temporaryDirectories.push(cwd);
    const expected = Buffer.alloc(FILE_SIZE);
    for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251;
    writeFileSync(join(cwd, "large.bin"), expected);

    daemon = await createTestPaseoDaemon();
    const source = await connectSocket(daemon.port, "shared-file-client");
    const unrelated = await connectSocket(daemon.port, "shared-file-client");
    sockets.push(source, unrelated);

    let unrelatedBinaryFrames = 0;
    unrelated.on("message", (_data, isBinary) => {
      if (isBinary) unrelatedBinaryFrames += 1;
    });

    const transfer = receiveFileTransfer(source, "req-large-file");
    source.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "file_explorer_request",
          cwd,
          path: "large.bin",
          mode: "file",
          acceptBinary: true,
          requestId: "req-large-file",
        },
      }),
    );

    await sendAndWait(
      unrelated,
      {
        type: "session",
        message: { type: "ping", requestId: "req-unrelated", clientSentAt: 1 },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "pong" &&
        message.message.payload.requestId === "req-unrelated",
    );

    const frames = await transfer;
    const chunks = frames.flatMap((frame) =>
      frame.opcode === FileTransferOpcode.FileChunk ? [frame.payload] : [],
    );
    expect(frames[0]?.opcode).toBe(FileTransferOpcode.FileBegin);
    expect(frames.at(-1)?.opcode).toBe(FileTransferOpcode.FileEnd);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 256 * 1024)).toBe(true);
    expect(Buffer.compare(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), expected)).toBe(
      0,
    );
    expect(source.readyState).toBe(WebSocket.OPEN);
    expect(unrelated.readyState).toBe(WebSocket.OPEN);
    expect(unrelatedBinaryFrames).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

async function connectSocket(
  port: number,
  clientId: string,
  capabilities?: Record<string, unknown>,
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await sendAndWait(
    socket,
    { type: "hello", clientId, clientType: "browser", protocolVersion: 1, capabilities },
    (message) =>
      message.type === "session" &&
      message.message.type === "status" &&
      message.message.payload.status === "server_info",
  );
  return socket;
}

function receiveFileTransfer(source: WebSocket, requestId: string) {
  return new Promise<NonNullable<ReturnType<typeof decodeFileTransferFrame>>[]>(
    (resolve, reject) => {
      const frames: NonNullable<ReturnType<typeof decodeFileTransferFrame>>[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for file transfer"));
      }, TEST_TIMEOUT_MS);
      const onMessage = (data: RawData, isBinary: boolean) => {
        if (!isBinary) return;
        const frame = decodeFileTransferFrame(new Uint8Array(data as Buffer));
        if (!frame || frame.requestId !== requestId) return;
        frames.push(frame);
        if (frame.opcode === FileTransferOpcode.FileEnd) {
          cleanup();
          resolve(frames);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Socket closed during file transfer"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        source.off("message", onMessage);
        source.off("close", onClose);
      };
      source.on("message", onMessage);
      source.on("close", onClose);
    },
  );
}

function sendAndWait(
  socket: WebSocket,
  message: unknown,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  const response = new Promise<WSOutboundMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
  socket.send(JSON.stringify(message));
  return response;
}

test("an awaited timeline framing overflow closes the actual daemon socket", async () => {
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const { default: pino } = await import("pino");
  const { Writable } = await import("node:stream");
  const messages: string[] = [];
  const logger = pino(
    { level: "warn" },
    new Writable({
      write(chunk, _encoding, done) {
        messages.push(JSON.parse(chunk.toString()).msg);
        done();
      },
    }),
  );
  daemon = await createTestPaseoDaemon({ logger });
  const client = createHostClient(`127.0.0.1:${daemon.port}`, {
    clientId: "framing-seed",
    reconnect: { enabled: false },
  });
  await client.connect();
  const api = createPaseoApi(client);
  try {
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agents = [];
    const text = "x".repeat(240 * 1024);
    for (const [index, rows] of [350, 90].entries()) {
      const agent = await workspace.agents.create({
        config: { provider: "claude/claude-test", modeId: "full-access" },
        title: `Framing overflow ${index}`,
      });
      agents.push(agent.id);
      for (let row = 0; row < rows; row++)
        await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "user_message",
          text,
        });
    }
    const source = await connectSocket(daemon.port, "framing-overflow", {
      binary_chunking_v1: true,
    });
    sockets.push(source);
    const closed = new Promise<void>((resolve) => source.once("close", () => resolve()));
    const firstChunk = new Promise<void>((resolve) => {
      const listener = (data: RawData, binary: boolean) => {
        if (!binary || (data as Buffer)[0] !== 0x31) return;
        source.off("message", listener);
        source.pause();
        resolve();
      };
      source.on("message", listener);
    });
    const fetch = (agentId: string, requestId: string) =>
      source.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "fetch_agent_timeline_request",
            requestId,
            agentId,
            direction: "tail",
            projection: "canonical",
            limit: 0,
          },
        }),
      );
    fetch(agents[0]!, "first");
    await firstChunk;
    fetch(agents[1]!, "overflow");
    await expect
      .poll(() => messages.includes("Closing physical WebSocket after outbound framing failure"), {
        timeout: 15000,
      })
      .toBe(true);
    expect(messages).not.toContain("Closing physical WebSocket at outbound high-water mark");
    source.resume();
    await closed;
  } finally {
    await api.dispose();
    await client.close();
  }
}, 60000);

test("malformed chunk metadata closes the daemon socket with a protocol error", async () => {
  daemon = await createTestPaseoDaemon();
  const source = await connectSocket(daemon.port, "invalid-framing", { binary_chunking_v1: true });
  sockets.push(source);
  const closed = new Promise<number>((resolve) => source.once("close", (code) => resolve(code)));
  source.send(new Uint8Array([0x31, 2, 0, 3, 65]));
  expect(await closed).toBe(1002);
});

test("recording share requires semantic workspace write permission", async () => {
  const { SessionInboundMessageSchema } = await import("./messages.js");
  const { SessionAuthorization } = await import("./authorization/index.js");
  const request = {
    type: "recording.share.begin.request",
    recipientAgentId: "agent_fixture",
    recordingId: "recording_fixture",
    manifest: { version: 1, segments: [] },
    requestId: "recording-permission",
  };
  const parsed = SessionInboundMessageSchema.safeParse(request);
  expect(parsed.success, "dedicated recording-share request is supported").toBe(true);
  if (!parsed.success) return;
  expect(new SessionAuthorization(["workspace.read"]).allowsInbound(parsed.data)).toBe(false);
  expect(new SessionAuthorization(["workspace.write"]).allowsInbound(parsed.data)).toBe(true);
  for (const operation of ["begin", "upload", "complete", "delete"] as const) {
    const incoming = {
      type: `recording.share.${operation}.request`,
    } as import("./messages.js").SessionInboundMessage;
    const outgoing = {
      type: `recording.share.${operation}.response`,
      payload: {},
    } as import("./messages.js").SessionOutboundMessage;
    expect(new SessionAuthorization(["workspace.read"]).allowsInbound(incoming)).toBe(false);
    expect(new SessionAuthorization(["workspace.write"]).allowsInbound(incoming)).toBe(true);
    expect(new SessionAuthorization(["workspace.read"]).allowsOutbound(outgoing)).toBe(false);
    expect(new SessionAuthorization(["workspace.write"]).allowsOutbound(outgoing)).toBe(true);
  }
});

test(
  "read-only daemon principal cannot invoke any recording share operation",
  async () => {
    let listener: import("./websocket-server.js").VoiceAssistantWebSocketServer | undefined;
    daemon = await createTestPaseoDaemon({
      onWebSocketServerReady: (server) => {
        listener = server;
      },
    });
    expect(listener).toBeDefined();
    const external = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => external.once("listening", resolve));
    external.on("connection", (socket) => {
      void listener!.attachExternalSocket(
        socket,
        { transport: "hub", hubDaemonId: "recording-readonly" },
        { principalId: "recording-readonly", permissions: ["workspace.read"] },
      );
    });
    try {
      const address = external.address();
      if (!address || typeof address === "string") throw new Error("Missing test socket address");
      const socket = await connectSocket(address.port, "recording-reader");
      sockets.push(socket);
      const shareId = "11111111-1111-4111-8111-111111111111";
      const requests = [
        {
          type: "recording.share.begin.request",
          recipientAgentId: "agent",
          recordingId: "recording",
          manifest: { version: 1, segments: [] },
        },
        { type: "recording.share.upload.request", shareId, segmentId: "segment" },
        { type: "recording.share.complete.request", shareId },
        { type: "recording.share.delete.request", shareId, recipientAgentId: "agent" },
      ];
      for (const [index, request] of requests.entries()) {
        const requestId = `reader-${index}`;
        const denied = await sendAndWait(
          socket,
          { type: "session", message: { ...request, requestId } },
          (message) =>
            message.type === "session" &&
            message.message.type === "rpc_error" &&
            message.message.payload.requestId === requestId,
        );
        expect(
          denied.type === "session" &&
            denied.message.type === "rpc_error" &&
            denied.message.payload.code,
        ).toBe("access_denied");
      }
      socket.terminate();
    } finally {
      for (const socket of external.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        external.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    }
  },
  TEST_TIMEOUT_MS,
);

test("recording share enforces streaming limits before allocating a transfer", async () => {
  const { SessionInboundMessageSchema } = await import("./messages.js");
  const request = {
    type: "recording.share.begin.request",
    recipientAgentId: "agent_fixture",
    recordingId: "recording_fixture",
    manifest: {
      version: 1,
      segments: [{ id: "too_large", size: 1024 * 1024 * 1024, sha256: "0".repeat(64) }],
    },
    requestId: "recording-limit",
  };
  expect(SessionInboundMessageSchema.safeParse(request).success).toBe(false);
});

test(
  "recording share rejects an unauthorized recipient",
  async () => {
    daemon = await createTestPaseoDaemon();
    const socket = await connectSocket(daemon.port, "recording-recipient-test");
    sockets.push(socket);
    const response = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.begin.request",
          recipientAgentId: "missing-agent",
          recordingId: "recording_fixture",
          manifest: { version: 1, segments: [] },
          requestId: "recording-recipient",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.begin.response" &&
        (message.message as { payload?: { requestId?: string } }).payload?.requestId ===
          "recording-recipient",
    );
    const result = response as unknown as {
      message: { payload: { success: boolean; error: unknown } };
    };
    expect(result.message.payload.success).toBe(false);
    expect(result.message.payload.error).toBeTruthy();
  },
  TEST_TIMEOUT_MS,
);

test(
  "recording share opens a bounded transfer for the selected live agent",
  async () => {
    daemon = await createTestPaseoDaemon();
    const recipient = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.staticDir },
      undefined,
      { initialTitle: "Recording recipient" },
    );
    const socket = await connectSocket(daemon.port, "recording-share-test");
    sockets.push(socket);
    const parts = [Buffer.alloc(3 * 1024 * 1024, 0x61), Buffer.alloc(3 * 1024 * 1024 + 9, 0x62)];
    const manifest = {
      version: 1,
      segments: parts.map((bytes, index) => ({
        id: `segment_${index}`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
    };
    const response = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.begin.request",
          recipientAgentId: recipient.id,
          recordingId: "recording_fixture",
          manifest,
          requestId: "recording-begin",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.begin.response" &&
        (message.message as { payload?: { requestId?: string } }).payload?.requestId ===
          "recording-begin",
    );
    const result = response as unknown as {
      message: { payload: { success: boolean; error: unknown; shareId: string | null } };
    };
    expect(result.message.payload.error).toBeNull();
    expect(result.message.payload.success).toBe(true);
    expect(result.message.payload.shareId).toMatch(/^[a-zA-Z0-9_-]+$/);
    const shareId = result.message.payload.shareId!;
    const pendingDirectory = join(daemon.paseoHome, "recording-shares", shareId);
    const incomplete = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.complete.request",
          shareId,
          requestId: "complete-incomplete",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.complete.response",
    );
    expect(
      (incomplete as unknown as { message: { payload: { success: boolean } } }).message.payload
        .success,
    ).toBe(false);
    expect(
      await sendFaultyRecordingUpload(
        socket,
        shareId,
        "short",
        parts[0].length,
        Buffer.from("short"),
        "end",
      ),
    ).toBe(false);
    expect(existsSync(join(pendingDirectory, "segment_0.part"))).toBe(false);
    expect(
      await sendFaultyRecordingUpload(
        socket,
        shareId,
        "long",
        parts[0].length,
        Buffer.alloc(parts[0].length + 1),
        "end",
      ),
    ).toBe(false);
    expect(existsSync(join(pendingDirectory, "segment_0.part"))).toBe(false);
    expect(
      await sendFaultyRecordingUpload(
        socket,
        shareId,
        "cancel",
        parts[0].length,
        Buffer.from("partial"),
        "cancel",
      ),
    ).toBe(false);
    expect(existsSync(join(pendingDirectory, "segment_0.part"))).toBe(false);
    expect(
      await sendFaultyRecordingUpload(
        socket,
        shareId,
        "trailing",
        parts[0].length,
        parts[0],
        "trailing",
      ),
    ).toBe(false);
    expect(existsSync(join(pendingDirectory, "segment_0.part"))).toBe(false);
    const outsider = await connectSocket(daemon.port, "recording-outsider-test");
    sockets.push(outsider);
    const acknowledgements: string[] = [];
    let leakedAcknowledgements = 0;
    socket.on("message", (data, binary) => {
      if (binary) return;
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (
        parsed.success &&
        parsed.data.type === "session" &&
        parsed.data.message.type === "fs.transfer.ack"
      )
        acknowledgements.push(parsed.data.message.requestId);
    });
    outsider.on("message", (data, binary) => {
      if (binary) return;
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (
        parsed.success &&
        parsed.data.type === "session" &&
        parsed.data.message.type === "fs.transfer.ack"
      )
        leakedAcknowledgements++;
    });
    const forbidden = await sendAndWait(
      outsider,
      {
        type: "session",
        message: {
          type: "recording.share.upload.request",
          shareId,
          segmentId: "segment_0",
          requestId: "outsider-upload",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.upload.response",
    );
    expect(
      (forbidden as unknown as { message: { payload: { success: boolean } } }).message.payload
        .success,
    ).toBe(false);
    const tooLargeId = "recording-oversized-chunk";
    const oversized = sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.upload.request",
          shareId,
          segmentId: "segment_0",
          requestId: tooLargeId,
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.upload.response" &&
        (message.message as { payload?: { requestId?: string } }).payload?.requestId === tooLargeId,
    );
    socket.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: tooLargeId,
        metadata: {
          mime: "application/octet-stream",
          size: parts[0].length,
          encoding: "binary",
          modifiedAt: new Date().toISOString(),
        },
      }),
    );
    socket.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: tooLargeId,
        payload: Buffer.alloc(256 * 1024 + 1),
      }),
    );
    expect(
      ((await oversized) as unknown as { message: { payload: { success: boolean } } }).message
        .payload.success,
    ).toBe(false);
    const badRequestId = "recording-bad-hash";
    const badUpload = sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.upload.request",
          shareId,
          segmentId: "segment_0",
          requestId: badRequestId,
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.upload.response" &&
        (message.message as { payload?: { requestId?: string } }).payload?.requestId ===
          badRequestId,
    );
    socket.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: badRequestId,
        metadata: {
          mime: "application/octet-stream",
          size: parts[0].length,
          encoding: "binary",
          modifiedAt: new Date().toISOString(),
        },
      }),
    );
    for (let offset = 0; offset < parts[0].length; offset += 64 * 1024)
      socket.send(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId: badRequestId,
          payload: Buffer.alloc(Math.min(64 * 1024, parts[0].length - offset)),
        }),
      );
    socket.send(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId: badRequestId }),
    );
    expect(
      ((await badUpload) as unknown as { message: { payload: { success: boolean } } }).message
        .payload.success,
    ).toBe(false);
    for (const [index, bytes] of parts.entries()) {
      const requestId = `recording-upload-${index}`;
      const uploaded = sendAndWait(
        socket,
        {
          type: "session",
          message: {
            type: "recording.share.upload.request",
            shareId,
            segmentId: `segment_${index}`,
            requestId,
          },
        },
        (message) =>
          message.type === "session" &&
          (message.message as { type: string }).type === "recording.share.upload.response" &&
          (message.message as { payload?: { requestId?: string } }).payload?.requestId ===
            requestId,
      );
      if (index === 0) {
        const collision = await sendAndWait(
          socket,
          {
            type: "session",
            message: {
              type: "file.upload.request",
              fileName: "collision.bin",
              mimeType: "application/octet-stream",
              size: 1,
              modifiedAt: new Date().toISOString(),
              requestId,
            },
          },
          (message) =>
            message.type === "session" &&
            message.message.type === "rpc_error" &&
            message.message.payload.requestId === requestId,
        );
        expect(collision.type === "session" && collision.message.type === "rpc_error").toBe(true);
      }
      const modifiedAt = new Date().toISOString();
      socket.send(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileBegin,
          requestId,
          metadata: {
            mime: "application/octet-stream",
            size: bytes.length,
            encoding: "binary",
            modifiedAt,
          },
        }),
      );
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
        socket.send(
          encodeFileTransferFrame({
            opcode: FileTransferOpcode.FileChunk,
            requestId,
            payload: bytes.subarray(offset, offset + 64 * 1024),
          }),
        );
      socket.send(encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }));
      const reply = (await uploaded) as unknown as {
        message: { payload: { success: boolean; error: unknown } };
      };
      expect(reply.message.payload).toMatchObject({ success: true, error: null });
      if (index === 0) {
        const duplicate = await sendAndWait(
          socket,
          {
            type: "session",
            message: {
              type: "recording.share.upload.request",
              shareId,
              segmentId: "segment_0",
              requestId: "duplicate-segment",
            },
          },
          (message) =>
            message.type === "session" &&
            (message.message as { type: string }).type === "recording.share.upload.response" &&
            (message.message as { payload?: { requestId?: string } }).payload?.requestId ===
              "duplicate-segment",
        );
        expect(
          (duplicate as unknown as { message: { payload: { success: boolean } } }).message.payload
            .success,
        ).toBe(false);
      }
    }
    expect(acknowledgements).toContain("recording-upload-0");
    expect(acknowledgements).toContain("recording-upload-1");
    expect(leakedAcknowledgements).toBe(0);
    const completed = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.complete.request",
          shareId,
          requestId: "recording-complete",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.complete.response",
    );
    const finish = completed as unknown as {
      message: { payload: { success: boolean; error: unknown; manifestPath: string } };
    };
    expect(finish.message.payload).toMatchObject({ success: true, error: null });
    const directory = join(finish.message.payload.manifestPath, "..");
    for (const [index, bytes] of parts.entries())
      expect(readFileSync(join(directory, `segment_${index}.bin`))).toEqual(bytes);
    const denied = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.delete.request",
          shareId,
          recipientAgentId: "another-agent",
          requestId: "recording-denied",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.delete.response",
    );
    expect(
      (denied as unknown as { message: { payload: { success: boolean } } }).message.payload.success,
    ).toBe(false);
    expect(existsSync(directory)).toBe(true);
    const deleted = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.delete.request",
          shareId,
          recipientAgentId: recipient.id,
          requestId: "recording-delete",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.delete.response",
    );
    expect(
      (deleted as unknown as { message: { payload: { success: boolean } } }).message.payload
        .success,
    ).toBe(true);
    expect(existsSync(directory)).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test(
  "disconnect removes an incomplete recording share",
  async () => {
    daemon = await createTestPaseoDaemon();
    const recipient = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.staticDir },
      undefined,
      { initialTitle: "Interrupted share recipient" },
    );
    const socket = await connectSocket(daemon.port, "recording-disconnect-test");
    sockets.push(socket);
    const response = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.begin.request",
          recipientAgentId: recipient.id,
          recordingId: "incomplete",
          manifest: {
            version: 1,
            segments: [{ id: "partial", size: 65536, sha256: "0".repeat(64) }],
          },
          requestId: "disconnect-begin",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.begin.response",
    );
    const shareId = (response as unknown as { message: { payload: { shareId: string } } }).message
      .payload.shareId;
    const directory = join(daemon.paseoHome, "recording-shares", shareId);
    expect(existsSync(directory)).toBe(true);
    const requestId = "disconnect-upload";
    socket.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "recording.share.upload.request",
          shareId,
          segmentId: "partial",
          requestId,
        },
      }),
    );
    socket.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: "application/octet-stream",
          size: 65536,
          encoding: "binary",
          modifiedAt: new Date().toISOString(),
        },
      }),
    );
    socket.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId,
        payload: Buffer.alloc(1024),
      }),
    );
    await expect.poll(() => existsSync(join(directory, "partial.part"))).toBe(true);
    socket.terminate();
    await expect.poll(() => existsSync(directory)).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test(
  "recording share removes interrupted staging and preserves completed copies",
  async () => {
    const { mkdirSync } = await import("node:fs");
    daemon = await createTestPaseoDaemon();
    const root = join(daemon.paseoHome, "recording-shares");
    const interrupted = join(root, "11111111-1111-4111-8111-111111111111");
    const completed = join(root, "22222222-2222-4222-8222-222222222222");
    mkdirSync(interrupted, { recursive: true });
    mkdirSync(completed, { recursive: true });
    writeFileSync(join(interrupted, "manifest.pending.json"), "{}");
    writeFileSync(
      join(completed, "manifest.json"),
      JSON.stringify({
        recipientAgentId: "saved",
        recordingId: "saved",
        manifest: { version: 1, segments: [] },
      }),
    );
    const recipient = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.staticDir },
      undefined,
      { initialTitle: "Recovery recipient" },
    );
    const socket = await connectSocket(daemon.port, "recording-recovery-test");
    sockets.push(socket);
    const response = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.begin.request",
          recipientAgentId: recipient.id,
          recordingId: "recovery",
          manifest: { version: 1, segments: [] },
          requestId: "recovery-begin",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.begin.response",
    );
    expect(
      (response as unknown as { message: { payload: { success: boolean } } }).message.payload
        .success,
    ).toBe(true);
    expect(existsSync(interrupted)).toBe(false);
    expect(existsSync(join(completed, "manifest.json"))).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

async function sendFaultyRecordingUpload(
  socket: WebSocket,
  shareId: string,
  requestId: string,
  declaredSize: number,
  bytes: Buffer,
  ending: "end" | "cancel" | "trailing",
): Promise<boolean> {
  const response = sendAndWait(
    socket,
    {
      type: "session",
      message: {
        type: "recording.share.upload.request",
        shareId,
        segmentId: "segment_0",
        requestId,
      },
    },
    (message) =>
      message.type === "session" &&
      (message.message as { type: string }).type === "recording.share.upload.response" &&
      (message.message as { payload?: { requestId?: string } }).payload?.requestId === requestId,
  );
  socket.send(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "application/octet-stream",
        size: declaredSize,
        encoding: "binary",
        modifiedAt: new Date().toISOString(),
      },
    }),
  );
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
    socket.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId,
        payload: bytes.subarray(offset, offset + 64 * 1024),
      }),
    );
  if (ending === "cancel")
    socket.send(
      JSON.stringify({ type: "session", message: { type: "fs.transfer.cancel", requestId } }),
    );
  else {
    socket.send(encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }));
    if (ending === "trailing")
      socket.send(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId,
          payload: new Uint8Array([1]),
        }),
      );
  }
  return ((await response) as unknown as { message: { payload: { success: boolean } } }).message
    .payload.success;
}

test(
  "recording share rejects an excessive aggregate reservation",
  async () => {
    daemon = await createTestPaseoDaemon();
    const recipient = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.staticDir },
      undefined,
      { initialTitle: "Quota recipient" },
    );
    const socket = await connectSocket(daemon.port, "recording-quota-test");
    sockets.push(socket);
    const segments = Array.from({ length: 65 }, (_, index) => ({
      id: `segment_${index}`,
      size: 16 * 1024 * 1024,
      sha256: "0".repeat(64),
    }));
    const response = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.begin.request",
          recipientAgentId: recipient.id,
          recordingId: "oversized",
          manifest: { version: 1, segments },
          requestId: "aggregate-limit",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.begin.response",
    );
    expect(
      (response as unknown as { message: { payload: { success: boolean } } }).message.payload
        .success,
    ).toBe(false);
    const caseCollision = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.begin.request",
          recipientAgentId: recipient.id,
          recordingId: "case_collision",
          manifest: {
            version: 1,
            segments: ["A", "a"].map((id) => ({ id, size: 0, sha256: "0".repeat(64) })),
          },
          requestId: "case-collision",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.begin.response" &&
        (message.message as { payload?: { requestId?: string } }).payload?.requestId ===
          "case-collision",
    );
    expect(
      (caseCollision as unknown as { message: { payload: { success: boolean } } }).message.payload
        .success,
    ).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test(
  "recording share quota preserves retained copies",
  async () => {
    const { mkdirSync } = await import("node:fs");
    daemon = await createTestPaseoDaemon();
    const root = join(daemon.paseoHome, "recording-shares");
    const segments = Array.from({ length: 64 }, (_, index) => ({
      id: `part_${index}`,
      size: 16 * 1024 * 1024,
      sha256: "0".repeat(64),
    }));
    const directories = Array.from({ length: 4 }, (_, index) =>
      join(root, `${String(index + 1).repeat(8)}-1111-4111-8111-111111111111`),
    );
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "manifest.json"),
        JSON.stringify({
          recipientAgentId: "saved",
          recordingId: "saved",
          manifest: { version: 1, segments },
        }),
      );
    }
    const recipient = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.staticDir },
      undefined,
      { initialTitle: "Quota recipient" },
    );
    const socket = await connectSocket(daemon.port, "recording-retained-quota-test");
    sockets.push(socket);
    const response = await sendAndWait(
      socket,
      {
        type: "session",
        message: {
          type: "recording.share.begin.request",
          recipientAgentId: recipient.id,
          recordingId: "overquota",
          manifest: { version: 1, segments: [{ id: "one", size: 1, sha256: "0".repeat(64) }] },
          requestId: "retained-quota",
        },
      },
      (message) =>
        message.type === "session" &&
        (message.message as { type: string }).type === "recording.share.begin.response",
    );
    expect(
      (response as unknown as { message: { payload: { success: boolean } } }).message.payload
        .success,
    ).toBe(false);
    for (const directory of directories)
      expect(existsSync(join(directory, "manifest.json"))).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

test(
  "idle incomplete share expires and releases its owner",
  async () => {
    const { RecordingShareStore } = await import("./recording-share/store.js");
    const directory = mkdtempSync(join(tmpdir(), "paseo-share-idle-"));
    temporaryDirectories.push(directory);
    const expired = vi.fn();
    vi.useFakeTimers();
    try {
      const store = new RecordingShareStore(directory);
      const shareId = await store.begin(
        {},
        "agent",
        "recording",
        { version: 1, segments: [] },
        new AbortController().signal,
        expired,
      );
      expect(existsSync(join(directory, "recording-shares", shareId))).toBe(true);
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      vi.useRealTimers();
      await expect.poll(() => expired.mock.calls.length).toBe(1);
      expect(existsSync(join(directory, "recording-shares", shareId))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  },
  TEST_TIMEOUT_MS,
);

test("recording queue fits the transport acknowledgement window and one chunk", async () => {
  const { RECORDING_UPLOAD_QUEUE_BYTES, RECORDING_UPLOAD_CHUNK_BYTES } =
    await import("./recording-share/store.js");
  const { TRANSFER_WINDOW_BYTES, TRANSFER_ACK_INTERVAL_BYTES } =
    await import("@getpaseo/protocol/binary-frames/index");
  expect(TRANSFER_ACK_INTERVAL_BYTES).toBeLessThan(TRANSFER_WINDOW_BYTES);
  expect(RECORDING_UPLOAD_QUEUE_BYTES).toBeGreaterThanOrEqual(
    TRANSFER_WINDOW_BYTES + RECORDING_UPLOAD_CHUNK_BYTES,
  );
});

test(
  "a recording share can only complete once under concurrent requests",
  async () => {
    const { RecordingShareStore } = await import("./recording-share/store.js");
    const directory = mkdtempSync(join(tmpdir(), "paseo-share-completion-"));
    temporaryDirectories.push(directory);
    const store = new RecordingShareStore(directory);
    const source = {};
    const shareId = await store.begin(
      source,
      "agent",
      "recording",
      { version: 1, segments: [] },
      new AbortController().signal,
      () => {},
    );
    const outcomes = await Promise.allSettled([
      store.complete(source, shareId),
      store.complete(source, shareId),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(existsSync(join(directory, "recording-shares", shareId, "manifest.json"))).toBe(true);
  },
  TEST_TIMEOUT_MS,
);
