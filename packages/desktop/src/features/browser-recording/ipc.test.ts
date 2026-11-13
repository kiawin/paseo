import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { BrowserRecordingStore } from "./store.js";
import { CdpSessionQueue, SharedCdpSession } from "../browser-automation/cdp-session-queue.js";
import { NetworkRecorder } from "./network-recorder.js";

interface Caller {
  senderId: number;
  mainFrame: boolean;
  url?: string;
}
interface Bridge {
  start(caller: Caller, input: unknown): Promise<{ recordingId: string; status: string }>;
  stop(caller: Caller, input: unknown): Promise<void>;
  readEvents(caller: Caller, input: unknown): Promise<{ events: unknown[] }>;
  list(caller: Caller, input: unknown): Promise<{ recordings: Array<{ recordingId: string }> }>;
  readMedia(caller: Caller, input: unknown): Promise<{ bytes: Uint8Array }>;
  delete(caller: Caller, input: unknown): Promise<void>;
  hostClosed(senderId: number): Promise<void>;
  shutdown(): Promise<void>;
  onCdpEvent(
    contentsId: number,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): void;
  dispose(): Promise<void>;
}
interface Options {
  registry: PaseoBrowserWebviewRegistry;
  coordinator: BrowserRecordingCoordinator;
  store: BrowserRecordingStore;
  video: { start: (id: string) => Promise<void> };
  ensureInteractionReady: (contentsId: number) => Promise<void | boolean>;
  isTrustedHost: (senderId: number, url?: string) => boolean;
  notify: (senderId: number, value: unknown) => void;
  startupTimeoutMs?: number;
  getResponseBody: (
    contentsId: number,
    requestId: string,
    sessionId: string | null,
  ) => Promise<{ body: string; base64Encoded: boolean }>;
  getRequestPostData: (
    contentsId: number,
    requestId: string,
    sessionId: string | null,
  ) => Promise<{ postData: string }>;
  createBodyReader?: (contentsId: number) => {
    ready?: Promise<void>;
    getResponseBody: (
      requestId: string,
      sessionId: string | null,
    ) => Promise<{ body: string; base64Encoded: boolean }>;
    getRequestPostData: (
      requestId: string,
      sessionId: string | null,
    ) => Promise<{ postData: string }>;
    release: () => Promise<void>;
  };
}
const directories: string[] = [];
async function loadBudget() {
  const path = "./capture-budget.js";
  return import(path) as Promise<typeof import("./capture-budget.js")>;
}
async function loadBodyGate() {
  const path = "./body-read-gate.js";
  return import(path) as Promise<typeof import("./body-read-gate.js")>;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup(
  ready: (contentsId: number) => Promise<void | boolean> = async () => {},
  createBodyReader?: Options["createBodyReader"],
  startupTimeoutMs?: number,
  isTrustedHost: Options["isTrustedHost"] = (id) => id === 10,
) {
  const root = await mkdtemp(join(tmpdir(), "paseo-recording-ipc-"));
  directories.push(root);
  const store = new BrowserRecordingStore(root);
  const registry = new PaseoBrowserWebviewRegistry();
  registry.registerWebContents({ browserId: "root", webContentsId: 101, hostWebContentsId: 10 });
  registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
  const coordinator = new BrowserRecordingCoordinator(registry, () => false);
  const video = { start: vi.fn(async () => {}) };
  const notify = vi.fn();
  const getRequestPostData = vi.fn(async () => ({ postData: "fallback-post-body" }));
  const getResponseBody = vi.fn(async () => ({ body: "response-body", base64Encoded: false }));
  const modulePath = "./ipc.js";
  const module = (await import(modulePath)) as {
    createRecordingBridge: (options: Options) => Bridge;
  };
  const bridge = module.createRecordingBridge({
    registry,
    coordinator,
    store,
    video,
    ensureInteractionReady: ready,
    isTrustedHost,
    notify,
    getRequestPostData,
    getResponseBody,
    ...(createBodyReader ? { createBodyReader } : {}),
    ...(startupTimeoutMs ? { startupTimeoutMs } : {}),
  });
  return { bridge, store, coordinator, video, notify, getRequestPostData, root };
}

const owner: Caller = { senderId: 10, mainFrame: true };
describe("desktop recording bridge", () => {
  it("bounds physical body reads across views even when one command never settles", async () => {
    const { BodyReadGate } = await loadBodyGate();
    const gate = new BodyReadGate(1, 1, 5000);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.run(() => pending);
    const secondTask = vi.fn(async () => "next");
    const second = gate.run(secondTask);
    await expect(gate.run(async () => "overflow")).rejects.toThrow("queue is full");
    expect(secondTask).not.toHaveBeenCalled();
    release();
    await first;
    await expect(second).resolves.toBe("next");
    gate.close();
  });

  it("keeps a stalled recording from using every shared body-read slot", async () => {
    const { BodyReadGate } = await loadBodyGate();
    const global = new BodyReadGate(2, 2, 5000);
    const first = new BodyReadGate(1, 1, 5000);
    const second = new BodyReadGate(1, 1, 5000);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstTask = () => global.run(() => blocked);
    const secondTask = () => global.run(async () => "other-recording");
    const pending = first.run(firstTask);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(second.run(secondTask)).resolves.toBe("other-recording");
    release();
    await pending;
    first.close();
    second.close();
    global.close();
  });

  it("expires waiting body reads without replacing an occupied physical slot", async () => {
    const { BodyReadGate } = await loadBodyGate();
    vi.useFakeTimers();
    try {
      const gate = new BodyReadGate(1, 1, 25);
      let release!: () => void;
      const first = gate.run(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const waiting = gate.run(async () => "never");
      const rejected = expect(waiting).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(26);
      await rejected;
      const next = gate.run(async () => "next");
      release();
      await first;
      await expect(next).resolves.toBe("next");
      gate.close();
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds retained network transactions across recorded views and reports a gap", async () => {
    const { CaptureBudget } = await loadBudget();
    const budget = new CaptureBudget(2 * 1024 * 1024 + 4 * 1024);
    const gaps: string[] = [];
    const transactions: unknown[] = [];
    const options = {
      budget,
      maxBodyBytes: 512 * 1024,
      write: async (event: unknown) => {
        transactions.push(event);
      },
      getResponseBody: async () => ({ body: "ok", base64Encoded: false }),
      onGap: (reason: string) => gaps.push(reason),
    };
    const first = new NetworkRecorder(options);
    const second = new NetworkRecorder(options);
    const request = (id: string, large = false) => ({
      method: "Network.requestWillBeSent",
      params: {
        requestId: id,
        request: {
          url: "https://fixture.test",
          method: large ? "POST" : "GET",
          headers: {},
          ...(large ? { postData: "x".repeat(480 * 1024) } : {}),
        },
        timestamp: 1,
      },
    });
    await first.handle(request("first", true));
    await second.handle(request("limited"));
    expect(gaps).toContain("capture-memory-limit");
    await first.close();
    expect(budget.usedBytes).toBe(0);
    await second.handle(request("admitted"));
    await second.close();
    expect(budget.usedBytes).toBe(0);
    expect(transactions).toHaveLength(2);
  });

  it("prevents one recording from consuming the whole shared capture budget", async () => {
    const { CaptureBudget } = await loadBudget();
    const shared = new CaptureBudget(100);
    const first = new CaptureBudget(50, shared);
    const second = new CaptureBudget(50, shared);
    const releaseFirst = first.reserve(50);
    expect(first.reserve(1)).toBeNull();
    const releaseSecond = second.reserve(50);
    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();
    expect(shared.usedBytes).toBe(100);
    releaseFirst?.();
    releaseSecond?.();
    expect(shared.usedBytes).toBe(0);
  });

  it("keeps at least 64 ordinary concurrent requests within the shared budget", async () => {
    const { CaptureBudget } = await loadBudget();
    const budget = new CaptureBudget(64 * 1024 * 1024);
    const gaps: string[] = [];
    const transactions: unknown[] = [];
    const recorder = new NetworkRecorder({
      budget,
      maxBodyBytes: 256 * 1024,
      maxActiveRequests: 128,
      write: async (event) => {
        transactions.push(event);
      },
      getResponseBody: async () => ({ body: "ok", base64Encoded: false }),
      onGap: (reason) => gaps.push(reason),
    });
    for (let index = 0; index < 64; index++)
      await recorder.handle({
        method: "Network.requestWillBeSent",
        params: {
          requestId: `request-${index}`,
          request: {
            url: `https://fixture.test/${index}`,
            method: "GET",
            headers: { accept: "text/html" },
          },
        },
      });
    expect(gaps).not.toContain("capture-memory-limit");
    await recorder.close();
    expect(transactions).toHaveLength(64);
    expect(budget.usedBytes).toBe(0);
  });

  it("keeps request identity when its body exceeds the remaining memory budget", async () => {
    const { CaptureBudget } = await loadBudget();
    const budget = new CaptureBudget(70 * 1024);
    const transactions: Array<{
      request: { url: string; body: { state: string; reason?: string } };
    }> = [];
    const gaps: string[] = [];
    const recorder = new NetworkRecorder({
      budget,
      maxBodyBytes: 256 * 1024,
      write: async (event) => {
        transactions.push(event);
      },
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
      onGap: (reason) => gaps.push(reason),
    });
    await recorder.handle({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "large",
        request: {
          url: "https://fixture.test/kept",
          method: "POST",
          headers: {},
          postData: "x".repeat(100 * 1024),
        },
      },
    });
    await recorder.close();
    expect(transactions[0].request.url).toBe("https://fixture.test/kept");
    expect(transactions[0].request.body).toMatchObject({
      state: "unavailable",
      reason: "capture-memory-limit",
    });
    expect(gaps).toContain("capture-memory-limit");
    expect(budget.usedBytes).toBe(0);
  });

  it("keeps already captured headers when a late header exceeds the budget", async () => {
    const { CaptureBudget } = await loadBudget();
    const budget = new CaptureBudget(70 * 1024);
    const transactions: Array<{ request: { headers: Record<string, string> } }> = [];
    const gaps: string[] = [];
    const recorder = new NetworkRecorder({
      budget,
      write: async (event) => {
        transactions.push(event);
      },
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
      onGap: (reason) => gaps.push(reason),
    });
    await recorder.handle({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "headers",
        request: { url: "https://fixture.test", method: "GET", headers: { "x-original": "keep" } },
      },
    });
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "headers", headers: { "x-late": "x".repeat(4000) } },
    });
    await recorder.close();
    expect(transactions[0].request.headers["x-original"]).toBe("keep");
    expect(gaps).toContain("capture-memory-limit");
    expect(budget.usedBytes).toBe(0);
  });

  it("bounds early network headers across views and releases them on close", async () => {
    const { CaptureBudget } = await loadBudget();
    const budget = new CaptureBudget(512 * 1024);
    const gaps: string[] = [];
    const options = {
      budget,
      write: async () => {},
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
      onGap: (reason: string) => gaps.push(reason),
    };
    const first = new NetworkRecorder(options);
    const second = new NetworkRecorder(options);
    await first.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "a", headers: { "x-example": "x".repeat(64 * 1024) } },
    });
    await second.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "b", headers: { "x-example": "x".repeat(64 * 1024) } },
    });
    expect(gaps).toContain("capture-memory-limit");
    await first.close();
    await second.close();
    expect(budget.usedBytes).toBe(0);
  });

  it("admits a burst of small early headers without starving other requests", async () => {
    const { CaptureBudget } = await loadBudget();
    const budget = new CaptureBudget(4 * 1024 * 1024);
    const gaps: string[] = [];
    const options = {
      budget,
      write: async () => {},
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
      onGap: (reason: string) => gaps.push(reason),
    };
    const first = new NetworkRecorder(options);
    const second = new NetworkRecorder(options);
    for (let index = 0; index < 40; index++)
      await first.handle({
        method: "Network.requestWillBeSentExtraInfo",
        params: { requestId: `early-${index}`, headers: { accept: "text/html" } },
      });
    await second.handle({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "other",
        request: { url: "https://fixture.test", method: "GET", headers: {} },
      },
    });
    expect(gaps).not.toContain("capture-memory-limit");
    await first.close();
    await second.close();
    expect(budget.usedBytes).toBe(0);
  });

  it("bounds fallback POST data and discloses that uploaded file bytes may be omitted", async () => {
    const transactions: Array<{
      request: { body: { state: string; data?: string } };
      limitations?: string[];
    }> = [];
    const recorder = new NetworkRecorder({
      maxBodyBytes: 1024,
      write: async (value) => {
        transactions.push(value);
      },
      getResponseBody: async () => ({ body: "ok", base64Encoded: false }),
      getRequestPostData: async () => ({ postData: "x".repeat(4096) }),
    });
    await recorder.handle({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "req",
        request: {
          url: "https://fixture.test",
          method: "POST",
          headers: {},
          hasPostData: true,
          postDataEntries: [{}],
        },
      },
    });
    await recorder.handle({
      method: "Network.responseReceived",
      params: { requestId: "req", response: { status: 200, headers: {} } },
    });
    await recorder.handle({ method: "Network.loadingFinished", params: { requestId: "req" } });
    await recorder.close();
    expect(transactions[0].request.body.state).toBe("truncated");
    expect(transactions[0].request.body.data).toHaveLength(1024);
    expect(transactions[0].limitations).toContain("request-body-file-bytes-may-be-omitted");
  });

  it("permits CDP POST fallback only for a verified bounded request size", async () => {
    const modulePath = "./request-body-policy.js";
    const { RequestBodyPolicy } = (await import(
      modulePath
    )) as typeof import("./request-body-policy.js");
    const policy = new RequestBodyPolicy(1024, 1);
    const request = (id: string) =>
      policy.observe("Network.requestWillBeSent", { requestId: id }, null);
    const extra = (id: string, headers: Record<string, string>) =>
      policy.observe("Network.requestWillBeSentExtraInfo", { requestId: id, headers }, null);
    request("small");
    extra("small", { "Content-Length": "1024" });
    await expect(policy.assertAllowed("small", null)).resolves.toBeUndefined();
    request("large");
    extra("large", { "Content-Length": "1025" });
    await expect(policy.assertAllowed("large", null)).rejects.toThrow("request-body-too-large");
    request("unknown");
    await expect(policy.assertAllowed("unknown", null)).rejects.toThrow(
      "request-body-size-unknown",
    );
    request("chunked");
    extra("chunked", { "Content-Length": "12", "Transfer-Encoding": "chunked" });
    await expect(policy.assertAllowed("chunked", null)).rejects.toThrow(
      "request-body-size-unknown",
    );
    request("redirect");
    extra("redirect", { "Content-Length": "12" });
    request("redirect");
    extra("redirect", { "Content-Length": "12" });
    await expect(policy.assertAllowed("redirect", null)).rejects.toThrow(
      "request-body-size-unknown",
    );
  });

  it("does not attribute a late POST fallback to the wrong redirect hop", async () => {
    let resolveBody!: (value: { postData: string }) => void;
    const body = new Promise<{ postData: string }>((resolve) => {
      resolveBody = resolve;
    });
    const transactions: Array<{
      request: { body: { state: string; reason?: string } };
      limitations?: string[];
    }> = [];
    const recorder = new NetworkRecorder({
      write: async (value) => {
        transactions.push(value);
      },
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
      getRequestPostData: () => body,
    });
    await recorder.handle({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "redirect",
        request: {
          url: "https://fixture.test/first",
          method: "POST",
          headers: {},
          hasPostData: true,
        },
      },
    });
    await recorder.handle({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "redirect",
        request: { url: "https://fixture.test/second", method: "GET", headers: {} },
        redirectResponse: { status: 302, headers: {} },
      },
    });
    resolveBody({ postData: "ambiguous" });
    await recorder.close();
    expect(transactions[0].request.body).toMatchObject({
      state: "unavailable",
      reason: "request-body-redirect-ambiguous",
    });
    expect(transactions[0].limitations).toContain("request-body-redirect-ambiguous");
  });

  it("retains POST fallback data that completed before a redirect", async () => {
    const transactions: Array<{ request: { body: { state: string; data?: string } } }> = [];
    const recorder = new NetworkRecorder({
      write: async (value) => {
        transactions.push(value);
      },
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
      getRequestPostData: async () => ({ postData: "first-hop" }),
    });
    await recorder.handle({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "redirect",
        request: {
          url: "https://fixture.test/first",
          method: "POST",
          headers: {},
          hasPostData: true,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await recorder.handle({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "redirect",
        request: { url: "https://fixture.test/second", method: "GET", headers: {} },
        redirectResponse: { status: 302, headers: {} },
      },
    });
    await recorder.close();
    expect(transactions[0].request.body).toMatchObject({ state: "complete", data: "first-hop" });
  });
  it("prioritizes interactive browser commands over queued recording reads", async () => {
    const queue = new CdpSessionQueue();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      order.push("first");
      await blocked;
    }, "background");
    await Promise.resolve();
    const recording = queue.run(async () => {
      order.push("recording");
    }, "background");
    const interactive = queue.run(async () => {
      order.push("interactive");
    });
    release();
    await Promise.all([first, recording, interactive]);
    expect(order).toEqual(["first", "interactive", "recording"]);
  });

  it("does not block automation on an unresolved recording body read", async () => {
    let attached = false;
    let release!: (value: unknown) => void;
    const blocked = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const debuggerClient = {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      sendCommand: async (command: string) =>
        command === "Network.getResponseBody" ? blocked : { ok: true },
    };
    const session = new SharedCdpSession(debuggerClient);
    const consumer = session.createConsumer({});
    const body = consumer.sendBackgroundCommand("Network.getResponseBody", { requestId: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(session.sendCommand("Runtime.evaluate", { expression: "1" })).resolves.toEqual({
      ok: true,
    });
    release({ body: "ok", base64Encoded: false });
    await body;
    await consumer.release();
  });
  it("rejects guest, subframe, forged browser and path traversal requests", async () => {
    const { bridge } = await setup();
    try {
      await expect(
        bridge.start({ senderId: 101, mainFrame: true }, { browserId: "root" }),
      ).rejects.toThrow();
      await expect(
        bridge.start({ senderId: 10, mainFrame: false }, { browserId: "root" }),
      ).rejects.toThrow();
      await expect(
        bridge.start(owner, { browserId: "other", hostWebContentsId: 10 }),
      ).rejects.toThrow();
      await expect(
        bridge.list({ senderId: 101, mainFrame: true }, { workspaceId: "workspace" }),
      ).rejects.toThrow();
      await expect(
        bridge.delete({ senderId: 10, mainFrame: false }, { recordingId: "recording" }),
      ).rejects.toThrow();
      await expect(
        bridge.readMedia(owner, {
          recordingId: "recording",
          streamId: "stream",
          segmentId: "segment",
          offset: 0,
          length: 2 * 1024 * 1024,
        }),
      ).rejects.toThrow();
      for (const recordingId of ["../other", "/tmp/other", "", "a/b"]) {
        await expect(
          bridge.readEvents(owner, { recordingId, cursor: 0, maxBytes: 4096 }),
        ).rejects.toThrow();
        await expect(bridge.stop(owner, { recordingId })).rejects.toThrow();
      }
    } finally {
      await bridge.dispose();
    }
  });

  it("derives caller identity from the Electron IPC event rather than the payload", async () => {
    const { bridge } = await setup();
    const modulePath = "./register-ipc.js";
    const { registerRecordingIpc } = (await import(
      modulePath
    )) as typeof import("./register-ipc.js");
    const handlers = new Map<
      string,
      (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown
    >();
    const registry = {
      handle: (
        channel: string,
        handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown,
      ) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      },
    };
    const unregister = registerRecordingIpc(
      registry,
      bridge as unknown as Parameters<typeof registerRecordingIpc>[1],
    );
    const frame = {};
    const event = (id: number, mainFrame: boolean) =>
      ({
        sender: { id, mainFrame: frame },
        senderFrame: mainFrame ? frame : {},
      }) as unknown as Electron.IpcMainInvokeEvent;
    try {
      const start = handlers.get("paseo:recording:start")!;
      await expect(start(event(101, true), { browserId: "root", senderId: 10 })).rejects.toThrow();
      await expect(start(event(10, false), { browserId: "root" })).rejects.toThrow();
      const recording = (await start(event(10, true), { browserId: "root" })) as {
        recordingId: string;
      };
      const stop = handlers.get("paseo:recording:stop")!;
      await stop(event(10, true), { recordingId: recording.recordingId });
    } finally {
      unregister();
      await bridge.dispose();
    }
    expect(handlers.size).toBe(0);
  });

  it("accepts only the configured app origin, while host cleanup needs no renderer URL", async () => {
    const modulePath = "./register-ipc.js";
    const { isTrustedRecordingUrl } = (await import(
      modulePath
    )) as typeof import("./register-ipc.js");
    expect(isTrustedRecordingUrl("paseo://app/workspace", true, "http://localhost:8081")).toBe(
      true,
    );
    expect(isTrustedRecordingUrl("paseo://evil/workspace", true, "http://localhost:8081")).toBe(
      false,
    );
    expect(isTrustedRecordingUrl("https://evil.test", true, "http://localhost:8081")).toBe(false);
    expect(
      isTrustedRecordingUrl("http://localhost:8081/workspace", false, "http://localhost:8081"),
    ).toBe(true);
    expect(
      isTrustedRecordingUrl("http://evil@localhost:8081/", false, "http://localhost:8081"),
    ).toBe(false);
    const { bridge, store } = await setup(
      undefined,
      undefined,
      undefined,
      (id, url) => id === 10 && isTrustedRecordingUrl(url ?? "", true, "http://localhost:8081"),
    );
    try {
      await expect(
        bridge.start(
          { senderId: 10, mainFrame: true, url: "https://evil.test" },
          { browserId: "root" },
        ),
      ).rejects.toThrow();
      const recording = await bridge.start(
        { senderId: 10, mainFrame: true, url: "paseo://app/" },
        { browserId: "root" },
      );
      await bridge.hostClosed(10);
      expect((await store.readMetadata(recording.recordingId)).status).toBe("interrupted");
    } finally {
      await bridge.dispose();
    }
  });

  it("waits for interaction readiness, starts video, persists status and notifies only its owner", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bridge, store, video, notify } = await setup(() => ready);
    try {
      let resolved = false;
      const starting = bridge.start(owner, { browserId: "root" }).then((value) => {
        resolved = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolved).toBe(false);
      release();
      const recording = await starting;
      expect(recording.status).toBe("recording");
      expect(video.start).toHaveBeenCalledWith(recording.recordingId);
      expect((await store.readMetadata(recording.recordingId)).status).toBe("recording");
      await expect(
        bridge.stop({ senderId: 101, mainFrame: true }, { recordingId: recording.recordingId }),
      ).rejects.toThrow();
      await bridge.stop(owner, { recordingId: recording.recordingId });
      expect((await store.readMetadata(recording.recordingId)).status).toBe("complete");
      expect(notify.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(notify.mock.calls.every(([senderId]) => senderId === 10)).toBe(true);
    } finally {
      await bridge.dispose();
    }
  });

  it("marks a failed startup interrupted and clears the visible starting state", async () => {
    const { bridge, store, notify } = await setup(async () => {
      throw new Error("instrumentation failed");
    });
    try {
      await expect(bridge.start(owner, { browserId: "root" })).rejects.toThrow(
        "instrumentation failed",
      );
      const updates = notify.mock.calls.map(
        ([, state]) => state as { recordingId: string; status: string },
      );
      expect(updates.map((state) => state.status)).toEqual(["starting", "interrupted"]);
      expect((await store.readMetadata(updates[0].recordingId)).status).toBe("interrupted");
    } finally {
      await bridge.dispose();
    }
  });

  it("does not allow deletion while failed startup is being persisted", async () => {
    const { bridge, store, notify } = await setup(async () => {
      throw new Error("instrumentation failed");
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = store.updateMetadata.bind(store);
    const spy = vi.spyOn(store, "updateMetadata").mockImplementation(async (...args) => {
      await gate;
      return update(...args);
    });
    try {
      const starting = bridge.start(owner, { browserId: "root" });
      const result = starting.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      const recordingId = (notify.mock.calls[0][1] as { recordingId: string }).recordingId;
      await expect(bridge.delete(owner, { recordingId })).rejects.toThrow("active");
      release();
      expect(await result).toBeInstanceOf(Error);
      expect((await store.readMetadata(recordingId)).status).toBe("interrupted");
    } finally {
      release();
      await bridge.dispose();
    }
  });

  it("shows an interaction startup gap only when readiness cannot be verified", async () => {
    const { bridge, store } = await setup(async () => false);
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      await bridge.stop(owner, { recordingId: recording.recordingId });
      expect(JSON.stringify((await store.readEvents(recording.recordingId)).events)).toContain(
        "interaction-startup-unverified",
      );
    } finally {
      await bridge.dispose();
    }
  });

  it("reports a storage failure during stop as interrupted", async () => {
    const { bridge, store, notify } = await setup();
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      vi.spyOn(store, "updateMetadata").mockRejectedValueOnce(
        new Error("synthetic storage failure"),
      );
      await expect(bridge.stop(owner, { recordingId: recording.recordingId })).rejects.toThrow(
        "synthetic storage failure",
      );
      expect((await store.readMetadata(recording.recordingId)).status).toBe("interrupted");
      const last = notify.mock.calls.at(-1);
      expect(last).toBeDefined();
      expect((last![1] as { status: string }).status).toBe("interrupted");
    } finally {
      await bridge.dispose();
    }
  });

  it("finalizes metadata when the root tab closes outside the bridge", async () => {
    const { bridge, coordinator, store, notify } = await setup();
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      await coordinator.stop(recording.recordingId);
      await vi.waitFor(async () =>
        expect((await store.readMetadata(recording.recordingId)).status).toBe("complete"),
      );
      expect(
        notify.mock.calls.some(([, value]) => (value as { status: string }).status === "complete"),
      ).toBe(true);
    } finally {
      await bridge.dispose();
    }
  });

  it("does not add a spurious network gap while stopping", async () => {
    const { bridge, coordinator, store } = await setup();
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      coordinator.subscribeStop(async () => {
        bridge.onCdpEvent(101, "Network.loadingFinished", { requestId: "late" });
      });
      await bridge.stop(owner, { recordingId: recording.recordingId });
      expect(JSON.stringify((await store.readEvents(recording.recordingId)).events)).not.toContain(
        "network-recorder-not-ready",
      );
    } finally {
      await bridge.dispose();
    }
  });

  it("interrupts startup promptly when the owning window closes", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bridge, store, notify, video } = await setup(() => ready);
    try {
      const starting = bridge.start(owner, { browserId: "root" });
      const result = starting.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(notify).toHaveBeenCalled());
      const recordingId = (notify.mock.calls[0][1] as { recordingId: string }).recordingId;
      await bridge.hostClosed(owner.senderId);
      expect(await result).toBeInstanceOf(Error);
      expect((await store.readMetadata(recordingId)).status).toBe("interrupted");
      expect(video.start).not.toHaveBeenCalled();
      release();
    } finally {
      release();
      await bridge.dispose();
    }
  });

  it("marks an active recording interrupted when its owning window closes", async () => {
    const { bridge, store, notify } = await setup();
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      await bridge.hostClosed(owner.senderId);
      expect((await store.readMetadata(recording.recordingId)).status).toBe("interrupted");
      expect(
        notify.mock.calls.some(
          ([, value]) => (value as { status: string }).status === "interrupted",
        ),
      ).toBe(true);
    } finally {
      await bridge.dispose();
    }
  });

  it("drains active recordings as interrupted during app shutdown", async () => {
    const { bridge, store } = await setup();
    const recording = await bridge.start(owner, { browserId: "root" });
    await bridge.shutdown();
    expect((await store.readMetadata(recording.recordingId)).status).toBe("interrupted");
    await expect(bridge.start(owner, { browserId: "root" })).rejects.toThrow("closed");
    await bridge.dispose();
  });

  it("marks a stalled startup interrupted after a bounded wait", async () => {
    const { bridge, store, notify } = await setup(() => new Promise<void>(() => {}), undefined, 30);
    try {
      await expect(bridge.start(owner, { browserId: "root" })).rejects.toThrow("startup timed out");
      const updates = notify.mock.calls.map(
        ([, value]) => value as { recordingId: string; status: string },
      );
      expect(updates.map((value) => value.status)).toEqual(["starting", "interrupted"]);
      expect((await store.readMetadata(updates[0].recordingId)).status).toBe("interrupted");
    } finally {
      await bridge.dispose();
    }
  });

  it("retrieves omitted request post data and records the response", async () => {
    const { bridge, getRequestPostData, store, coordinator } = await setup();
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      coordinator.registerFrame({ webContentsId: 101, frameId: "frame", documentId: "document" });
      bridge.onCdpEvent(101, "Network.requestWillBeSent", {
        requestId: "req",
        frameId: "frame",
        loaderId: "document",
        timestamp: 1,
        wallTime: 1,
        type: "Fetch",
        request: {
          url: "https://fixture.test/api",
          method: "POST",
          headers: {},
          hasPostData: true,
        },
      });
      bridge.onCdpEvent(101, "Network.responseReceived", {
        requestId: "req",
        response: { status: 200, headers: {}, mimeType: "text/plain" },
      });
      bridge.onCdpEvent(101, "Network.loadingFinished", { requestId: "req", timestamp: 2 });
      await bridge.stop(owner, { recordingId: recording.recordingId });
      const events = await store.readEvents(recording.recordingId);
      expect(getRequestPostData).toHaveBeenCalledWith(101, "req", null);
      expect(JSON.stringify(events.events)).toContain("fallback-post-body");
      expect(JSON.stringify(events.events)).toContain("response-body");
      expect(
        events.events.some(
          (event) =>
            event.kind === "network" &&
            event.frameAttribution === "identified" &&
            event.frameId === "frame" &&
            event.documentId === "document",
        ),
      ).toBe(true);
    } finally {
      await bridge.dispose();
    }
  });

  it("retains the network reader until a tail response is saved on stop", async () => {
    let releaseBody!: (value: { body: string; base64Encoded: boolean }) => void;
    const body = new Promise<{ body: string; base64Encoded: boolean }>((resolve) => {
      releaseBody = resolve;
    });
    const release = vi.fn(async () => {});
    const { bridge, store } = await setup(undefined, () => ({
      getResponseBody: () => body,
      getRequestPostData: async () => ({ postData: "" }),
      release,
    }));
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      bridge.onCdpEvent(101, "Network.requestWillBeSent", {
        requestId: "tail",
        request: { url: "https://fixture.test/tail", method: "GET", headers: {} },
      });
      bridge.onCdpEvent(101, "Network.responseReceived", {
        requestId: "tail",
        response: { status: 200, headers: {} },
      });
      bridge.onCdpEvent(101, "Network.loadingFinished", { requestId: "tail" });
      const stopped = bridge.stop(owner, { recordingId: recording.recordingId });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(release).not.toHaveBeenCalled();
      releaseBody({ body: "tail-response", base64Encoded: false });
      await stopped;
      expect(release).toHaveBeenCalledOnce();
      expect(JSON.stringify((await store.readEvents(recording.recordingId)).events)).toContain(
        "tail-response",
      );
    } finally {
      releaseBody({ body: "", base64Encoded: false });
      await bridge.dispose();
    }
  });

  it("records a visible gap when a network body reader fails to initialize", async () => {
    const { bridge, store } = await setup(undefined, () => ({
      ready: Promise.reject(new Error("unavailable")),
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
      getRequestPostData: async () => ({ postData: "" }),
      release: async () => {},
    }));
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      await bridge.stop(owner, { recordingId: recording.recordingId });
      expect(JSON.stringify((await store.readEvents(recording.recordingId)).events)).toContain(
        "network-reader-setup-failed",
      );
    } finally {
      await bridge.dispose();
    }
  });

  it("attaches a network reader when early popup instrumentation becomes available", async () => {
    let attempts = 0;
    const { bridge, store } = await setup(undefined, () => {
      if (attempts++ === 0) throw new Error("Guest is not instrumented");
      return {
        getResponseBody: async () => ({ body: "popup-response", base64Encoded: false }),
        getRequestPostData: async () => ({ postData: "" }),
        release: async () => {},
      };
    });
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      bridge.onCdpEvent(101, "Network.requestWillBeSent", {
        requestId: "early",
        request: { url: "https://fixture.test/early", method: "GET", headers: {} },
      });
      bridge.onCdpEvent(101, "Network.responseReceived", {
        requestId: "early",
        response: { status: 200, headers: {} },
      });
      bridge.onCdpEvent(101, "Network.loadingFinished", { requestId: "early" });
      await bridge.stop(owner, { recordingId: recording.recordingId });
      const events = (await store.readEvents(recording.recordingId)).events;
      expect(JSON.stringify(events)).toContain("popup-response");
      expect(JSON.stringify(events)).not.toContain("network-reader-unavailable");
    } finally {
      await bridge.dispose();
    }
  });

  it("lists, reads bounded media and deletes saved recordings while protecting active ones", async () => {
    const { bridge, store } = await setup();
    try {
      const recording = await bridge.start(owner, { browserId: "root" });
      expect(
        (await bridge.list(owner, { workspaceId: "workspace" })).recordings.map(
          (item) => item.recordingId,
        ),
      ).toContain(recording.recordingId);
      await expect(bridge.delete(owner, { recordingId: recording.recordingId })).rejects.toThrow();
      await store.writeMediaSegment(recording.recordingId, {
        streamId: "stream",
        segmentId: "segment",
        startMs: 0,
        durationMs: 1,
        mimeType: "video/webm",
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
      expect(
        (
          await bridge.readMedia(owner, {
            recordingId: recording.recordingId,
            streamId: "stream",
            segmentId: "segment",
            offset: 1,
            length: 2,
          })
        ).bytes,
      ).toEqual(new Uint8Array([2, 3]));
      await expect(
        bridge.readMedia(owner, {
          recordingId: recording.recordingId,
          streamId: "../stream",
          segmentId: "segment",
          offset: 0,
          length: 2,
        }),
      ).rejects.toThrow();
      await bridge.stop(owner, { recordingId: recording.recordingId });
      await bridge.delete(owner, { recordingId: recording.recordingId });
      expect((await bridge.list(owner, { workspaceId: "workspace" })).recordings).toEqual([]);
    } finally {
      await bridge.dispose();
    }
  });

  it("keeps metadata-less recording directories visible for explicit deletion", async () => {
    const { bridge, root } = await setup();
    try {
      await mkdir(join(root, "orphan"));
      const listing = (await bridge.list(owner, { workspaceId: "workspace" })) as {
        incomplete: string[];
      };
      expect(listing.incomplete).toContain("orphan");
      await bridge.delete(owner, { recordingId: "orphan" });
      expect(
        ((await bridge.list(owner, { workspaceId: "workspace" })) as { incomplete: string[] })
          .incomplete,
      ).not.toContain("orphan");
    } finally {
      await bridge.dispose();
    }
  });
});
