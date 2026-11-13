import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserKeyboard } from "../browser-keyboard/index.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";

const electron = vi.hoisted(() => ({ contents: new Map<number, unknown>() }));
const cdp = vi.hoisted(() => ({ send: vi.fn(), release: vi.fn(), contexts: [] as unknown[] }));
vi.mock("electron", () => ({
  ipcMain: new EventEmitter(),
  webContents: { fromId: (id: number) => electron.contents.get(id) ?? null },
}));
vi.mock("../browser-automation/ipc.js", () => ({
  getSharedCdpSession: () => ({
    runtimeContextSnapshot: () => ({ contexts: cdp.contexts, dropped: 0 }),
    createConsumer: () => ({ sendCommand: cdp.send, release: cdp.release }),
  }),
}));
import { createInteractionRecorder } from "./interaction-recorder.js";

function setup() {
  const ipc = new EventEmitter();
  const first = { processId: 1, frameToken: "frame-a", detached: false, send: vi.fn() };
  const second = { processId: 2, frameToken: "frame-b", detached: false, send: vi.fn() };
  const contents = {
    id: 10,
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [first, second] },
  };
  electron.contents.set(contents.id, contents);
  const registry = new PaseoBrowserWebviewRegistry();
  registry.registerWebContents({ webContentsId: 10, browserId: "root", hostWebContentsId: 1 });
  registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
  const coordinator = new BrowserRecordingCoordinator(registry, () => false);
  const sink = { write: vi.fn(async () => {}) };
  const errors: unknown[] = [];
  const recorder = createInteractionRecorder({
    coordinator,
    ipc: ipc as unknown as Electron.IpcMain,
    onError: (error) => errors.push(error),
  });
  recorder.registerIpc();
  coordinator.start({ recordingId: "recording", browserId: "root", hostWebContentsId: 1, sink });
  const event = (frame: typeof first, sender = contents) => ({ sender, senderFrame: frame });
  const nonce = "a".repeat(32);
  const click = {
    nonce,
    at: 1000,
    activation: "pointer",
    button: "primary",
    modifiers: { alt: false, control: false, meta: false, shift: false },
    element: {
      tag: "button",
      id: "submit",
      name: "",
      role: "",
      label: "Submit",
      href: "",
      truncated: false,
    },
  };
  return {
    ipc,
    first,
    second,
    contents,
    coordinator,
    registry,
    sink,
    recorder,
    errors,
    event,
    nonce,
    click,
  };
}
beforeEach(() => {
  electron.contents.clear();
  cdp.send.mockReset();
  cdp.release.mockReset().mockResolvedValue(undefined);
  cdp.contexts.length = 0;
});

describe("interaction sender validation", () => {
  it("bounds click floods and reports a rate-limit gap", async () => {
    vi.useFakeTimers();
    try {
      const { ipc, first, contents, coordinator, sink, recorder, event, nonce, click } = setup();
      coordinator.registerFrame({
        webContentsId: contents.id,
        frameId: "frame",
        documentId: "doc",
      });
      cdp.send.mockImplementation(async (method: string) =>
        method === "Runtime.evaluate"
          ? { result: { value: nonce } }
          : { frameTree: { frame: { id: "frame", loaderId: "doc" } } },
      );
      recorder.onCdpEvent(
        contents as unknown as Electron.WebContents,
        "Runtime.executionContextCreated",
        { context: { id: 25, name: "Electron Isolated Context", auxData: { frameId: "frame" } } },
      );
      ipc.emit("paseo:browser-recording-document", event(first), { nonce });
      await vi.advanceTimersByTimeAsync(0);
      expect(recorder.getFrameCount(contents.id)).toBe(1);
      for (let index = 0; index < 130; index++)
        ipc.emit("paseo:browser-recording-click", event(first), click);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        sink.write.mock.calls.filter(
          ([value]) => (value as { kind: string }).kind === "interaction",
        ),
      ).toHaveLength(120);
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "interaction-rate-limit" }),
        }),
      );
      recorder.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a live verified document when the document cache reaches its limit", async () => {
    const { ipc, first, contents, coordinator, sink, recorder, event, nonce, click } = setup();
    coordinator.registerFrame({ webContentsId: contents.id, frameId: "live", documentId: "doc" });
    cdp.send.mockImplementation(async (method: string) =>
      method === "Runtime.evaluate"
        ? { result: { value: nonce } }
        : { frameTree: { frame: { id: "live", loaderId: "doc" } } },
    );
    recorder.onCdpEvent(
      contents as unknown as Electron.WebContents,
      "Runtime.executionContextCreated",
      { context: { id: 22, name: "Electron Isolated Context", auxData: { frameId: "live" } } },
    );
    ipc.emit("paseo:browser-recording-document", event(first), { nonce });
    await vi.waitFor(() => expect(recorder.getFrameCount(contents.id)).toBe(1));
    for (let index = 0; index < 513; index++)
      ipc.emit("paseo:browser-recording-document", event(first), {
        nonce: index.toString(16).padStart(32, "0"),
      });
    ipc.emit("paseo:browser-recording-click", event(first), click);
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "interaction", frameId: "live", documentId: "doc" }),
      ),
    );
    recorder.dispose();
  });
  it("shares one stop promise if a pre-removal listener reenters stop", async () => {
    const { coordinator, recorder } = setup();
    let nested: Promise<void> | undefined;
    coordinator.subscribeBeforeRemoval(() => {
      nested = coordinator.stop("recording");
    });
    const first = coordinator.stop("recording");
    expect(nested).toBe(first);
    await first;
    recorder.dispose();
  });
  it("records pending setup before a descendant tab closes", async () => {
    const { contents, coordinator, registry, recorder, sink } = setup();
    const reservation = coordinator.reserveTabOpen(contents.id);
    const child = { ...contents, id: 13 };
    electron.contents.set(child.id, child);
    registry.registerWebContents({
      webContentsId: child.id,
      browserId: reservation.browserId,
      hostWebContentsId: 1,
    });
    registry.registerWorkspace({ browserId: reservation.browserId, workspaceId: "workspace" });
    coordinator.claimTabOpen({
      token: reservation.token,
      hostWebContentsId: 1,
      browserId: reservation.browserId,
    });
    coordinator.registerFrame({
      webContentsId: child.id,
      frameId: "pending-child",
      documentId: "doc",
    });
    recorder.onCdpEvent(child as unknown as Electron.WebContents, "Page.frameSnapshot", {
      frame: { id: "pending-child", loaderId: "doc" },
    });
    await coordinator.removeMember(child.id, "closed");
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({
          reason: "interaction-frame-instrumentation-unavailable",
        }),
      }),
    );
    recorder.dispose();
  });
  it("records pending frame setup before replacing a guest", async () => {
    const { contents, coordinator, registry, recorder, sink } = setup();
    coordinator.registerFrame({
      webContentsId: contents.id,
      frameId: "pending-replace",
      documentId: "doc",
    });
    recorder.onCdpEvent(contents as unknown as Electron.WebContents, "Page.frameSnapshot", {
      frame: { id: "pending-replace", loaderId: "doc" },
    });
    const replacement = { ...contents, id: 12 };
    electron.contents.set(replacement.id, replacement);
    registry.registerWebContents({
      webContentsId: replacement.id,
      browserId: "root",
      hostWebContentsId: 1,
    });
    coordinator.replaceBrowserGuest({ hostWebContentsId: 1, browserId: "root" });
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({
            reason: "interaction-frame-instrumentation-unavailable",
          }),
        }),
      ),
    );
    recorder.dispose();
  });
  it("does not report a false gap for a superseded document when the new one maps", async () => {
    vi.useFakeTimers();
    try {
      const { ipc, first, contents, coordinator, recorder, event, nonce, sink } = setup();
      cdp.send.mockImplementation(async (method: string) =>
        method === "Runtime.evaluate"
          ? { result: { value: nonce } }
          : { frameTree: { frame: { id: "frame", loaderId: "new" } } },
      );
      coordinator.registerFrame({
        webContentsId: contents.id,
        frameId: "frame",
        documentId: "old",
      });
      recorder.onCdpEvent(contents as unknown as Electron.WebContents, "Page.frameSnapshot", {
        frame: { id: "frame", loaderId: "old" },
      });
      coordinator.registerFrame({
        webContentsId: contents.id,
        frameId: "frame",
        documentId: "new",
      });
      recorder.onCdpEvent(contents as unknown as Electron.WebContents, "Page.frameNavigated", {
        frame: { id: "frame", loaderId: "new" },
      });
      recorder.onCdpEvent(
        contents as unknown as Electron.WebContents,
        "Runtime.executionContextCreated",
        { context: { id: 14, name: "Electron Isolated Context", auxData: { frameId: "frame" } } },
      );
      ipc.emit("paseo:browser-recording-document", event(first), { nonce });
      await vi.advanceTimersByTimeAsync(0);
      expect(recorder.getFrameCount(contents.id)).toBe(1);
      await vi.advanceTimersByTimeAsync(2001);
      expect(sink.write).not.toHaveBeenCalled();
      recorder.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("ignores detached and non-descendant sender frames", async () => {
    const { ipc, first, sink, recorder, event, nonce, click } = setup();
    const outsider = { processId: 9, frameToken: "outside", detached: false, send: vi.fn() };
    ipc.emit("paseo:browser-recording-document", event(outsider), { nonce });
    ipc.emit("paseo:browser-recording-click", event(outsider), click);
    first.detached = true;
    ipc.emit("paseo:browser-recording-document", event(first), { nonce });
    ipc.emit("paseo:browser-recording-click", event(first), click);
    await Promise.resolve();
    expect(
      sink.write.mock.calls.every(([value]) => (value as { kind: string }).kind !== "interaction"),
    ).toBe(true);
    recorder.dispose();
  });
  it("does not reattribute a stale nonce when revalidation fails", async () => {
    const { ipc, first, contents, coordinator, sink, recorder, event, nonce, click } = setup();
    coordinator.registerFrame({ webContentsId: contents.id, frameId: "frame", documentId: "old" });
    cdp.send.mockImplementation(async (method: string) =>
      method === "Runtime.evaluate"
        ? { result: { value: nonce } }
        : { frameTree: { frame: { id: "frame", loaderId: "old" } } },
    );
    recorder.onCdpEvent(
      contents as unknown as Electron.WebContents,
      "Runtime.executionContextCreated",
      { context: { id: 13, name: "Electron Isolated Context", auxData: { frameId: "frame" } } },
    );
    ipc.emit("paseo:browser-recording-document", event(first), { nonce });
    await vi.waitFor(() => expect(recorder.getFrameCount(contents.id)).toBe(1));
    cdp.send.mockRejectedValue(new Error("context destroyed"));
    coordinator.registerFrame({ webContentsId: contents.id, frameId: "frame", documentId: "new" });
    recorder.onCdpEvent(contents as unknown as Electron.WebContents, "Page.frameNavigated", {
      frame: { id: "frame", loaderId: "new" },
    });
    ipc.emit("paseo:browser-recording-click", event(first), click);
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "stale-document" }),
        }),
      ),
    );
    expect(
      sink.write.mock.calls.every(([value]) => (value as { kind: string }).kind !== "interaction"),
    ).toBe(true);
    recorder.dispose();
  });
  it("retains a verified document for a late IPC event but rejects it after navigation", async () => {
    const { ipc, first, contents, coordinator, sink, recorder, event, nonce, click } = setup();
    coordinator.registerFrame({ webContentsId: contents.id, frameId: "frame", documentId: "old" });
    cdp.send.mockImplementation(async (method: string) =>
      method === "Runtime.evaluate"
        ? { result: { value: nonce } }
        : { frameTree: { frame: { id: "frame", loaderId: "old" } } },
    );
    recorder.onCdpEvent(
      contents as unknown as Electron.WebContents,
      "Runtime.executionContextCreated",
      { context: { id: 12, name: "Electron Isolated Context", auxData: { frameId: "frame" } } },
    );
    ipc.emit("paseo:browser-recording-document", event(first), { nonce });
    await vi.waitFor(() => expect(recorder.getFrameCount(contents.id)).toBe(1));
    recorder.onCdpEvent(
      contents as unknown as Electron.WebContents,
      "Runtime.executionContextDestroyed",
      { executionContextId: 12 },
    );
    ipc.emit("paseo:browser-recording-click", event(first), click);
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "interaction", documentId: "old" }),
      ),
    );
    coordinator.registerFrame({ webContentsId: contents.id, frameId: "frame", documentId: "new" });
    ipc.emit("paseo:browser-recording-click", event(first), click);
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "stale-document" }),
        }),
      ),
    );
    expect(
      sink.write.mock.calls.filter(([value]) => (value as { kind: string }).kind === "interaction"),
    ).toHaveLength(1);
    recorder.dispose();
  });
  it("records a pending frame gap before automatic stop closes the sink", async () => {
    const { contents, coordinator, recorder, sink } = setup();
    coordinator.registerFrame({
      webContentsId: contents.id,
      frameId: "pending-stop",
      documentId: "doc",
    });
    recorder.onCdpEvent(contents as unknown as Electron.WebContents, "Page.frameSnapshot", {
      frame: { id: "pending-stop", loaderId: "doc" },
    });
    await coordinator.stop("recording");
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({
          reason: "interaction-frame-instrumentation-unavailable",
        }),
      }),
    );
    recorder.dispose();
  });
  it("records a pending frame gap before the root browser closes", async () => {
    const { contents, coordinator, recorder, sink } = setup();
    coordinator.registerFrame({
      webContentsId: contents.id,
      frameId: "pending-close",
      documentId: "doc",
    });
    recorder.onCdpEvent(contents as unknown as Electron.WebContents, "Page.frameSnapshot", {
      frame: { id: "pending-close", loaderId: "doc" },
    });
    await coordinator.removeMember(contents.id, "closed");
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({
          reason: "interaction-frame-instrumentation-unavailable",
        }),
      }),
    );
    recorder.dispose();
  });
  it("reports unavailable preload instrumentation without enabling it", async () => {
    const { ipc, first, sink, recorder, event } = setup();
    ipc.emit("paseo:browser-recording-document", event(first), {
      unavailable: true,
      requestState: true,
    });
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "interaction-preload-unavailable" }),
        }),
      ),
    );
    expect(first.send).toHaveBeenCalledWith("paseo:browser-recording-state", false);
    recorder.dispose();
  });
  it("reports a frame whose isolated instrumentation never becomes available", async () => {
    vi.useFakeTimers();
    try {
      const { contents, coordinator, recorder, sink } = setup();
      coordinator.registerFrame({
        webContentsId: contents.id,
        frameId: "missing-frame",
        documentId: "document",
      });
      recorder.onCdpEvent(contents as unknown as Electron.WebContents, "Page.frameSnapshot", {
        frame: { id: "missing-frame", loaderId: "document" },
      });
      expect(sink.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2001);
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({
            reason: "interaction-frame-instrumentation-unavailable",
          }),
        }),
      );
      recorder.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a context whose isolated nonce changes across frame-tree lookup", async () => {
    const { ipc, first, contents, coordinator, recorder, event, nonce, click, sink } = setup();
    coordinator.registerFrame({
      webContentsId: contents.id,
      frameId: "frame",
      documentId: "document",
    });
    let evaluations = 0;
    cdp.send.mockImplementation(async (method: string) =>
      method === "Runtime.evaluate"
        ? { result: { value: ++evaluations % 2 ? nonce : "b".repeat(32) } }
        : { frameTree: { frame: { id: "frame", loaderId: "document" } } },
    );
    recorder.onCdpEvent(
      contents as unknown as Electron.WebContents,
      "Runtime.executionContextCreated",
      { context: { id: 11, name: "Electron Isolated Context", auxData: { frameId: "frame" } } },
    );
    ipc.emit("paseo:browser-recording-document", event(first), { nonce });
    await vi.waitFor(() => expect(cdp.send.mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((resolve) => setImmediate(resolve));
    ipc.emit("paseo:browser-recording-click", event(first), click);
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "interaction-document-unverified" }),
        }),
      ),
    );
    expect(
      sink.write.mock.calls.every(([value]) => (value as { kind: string }).kind !== "interaction"),
    ).toBe(true);
    recorder.dispose();
  });
  it("bounds document and context registrations and removes IPC listeners on dispose", async () => {
    const { ipc, first, contents, recorder, event, sink } = setup();
    cdp.send.mockImplementation(() => new Promise(() => {}));
    for (let index = 0; index < 513; index++) {
      ipc.emit("paseo:browser-recording-document", event(first), {
        nonce: index.toString(16).padStart(32, "0"),
      });
    }
    for (let id = 0; id < 1025; id++)
      recorder.onCdpEvent(
        contents as unknown as Electron.WebContents,
        "Runtime.executionContextCreated",
        { context: { id, name: "Electron Isolated Context", auxData: { frameId: `frame-${id}` } } },
      );
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "interaction-document-limit" }),
        }),
      ),
    );
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({ reason: "interaction-context-limit" }),
      }),
    );
    recorder.dispose();
    expect(ipc.listenerCount("paseo:browser-recording-click")).toBe(0);
    expect(ipc.listenerCount("paseo:browser-recording-document")).toBe(0);
    expect(cdp.release).toHaveBeenCalled();
  });
  it("does not give the keyboard policy to an unregistered popup", () => {
    const keyboard = new BrowserKeyboard(new PaseoBrowserWebviewRegistry());
    const inspect = keyboard as unknown as {
      policyForGuest: (contents: { id: number }) => unknown;
    };
    expect(inspect.policyForGuest({ id: 999 })).toBeNull();
  });
  it("maps a context created before the frame navigation to the new document", async () => {
    const { ipc, first, contents, coordinator, sink, recorder, event, nonce, click } = setup();
    coordinator.registerFrame({
      webContentsId: contents.id,
      frameId: "cdp-frame",
      documentId: "old-document",
    });
    cdp.send.mockImplementation(async (method: string) =>
      method === "Runtime.evaluate"
        ? { result: { value: nonce } }
        : { frameTree: { frame: { id: "cdp-frame", loaderId: "new-document" } } },
    );
    recorder.onCdpEvent(
      contents as unknown as Electron.WebContents,
      "Runtime.executionContextCreated",
      { context: { id: 7, name: "Electron Isolated Context", auxData: { frameId: "cdp-frame" } } },
    );
    ipc.emit("paseo:browser-recording-document", event(first), { nonce });
    await vi.waitFor(() =>
      expect(cdp.send).toHaveBeenCalledWith("Page.getFrameTree", {}, undefined),
    );
    coordinator.registerFrame({
      webContentsId: contents.id,
      frameId: "cdp-frame",
      documentId: "new-document",
    });
    recorder.onCdpEvent(contents as unknown as Electron.WebContents, "Page.frameNavigated", {
      frame: { id: "cdp-frame", loaderId: "new-document" },
    });
    await vi.waitFor(() => expect(recorder.getFrameCount(contents.id)).toBe(1));
    ipc.emit("paseo:browser-recording-click", event(first), click);
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "interaction",
          frameId: "cdp-frame",
          documentId: "new-document",
          frameAttribution: "identified",
        }),
      ),
    );
    recorder.dispose();
  });
  it("records an unmapped legitimate click as unattributed with an explicit gap", async () => {
    const { ipc, first, contents, sink, recorder, event, nonce, click } = setup();
    cdp.send.mockImplementation(async (method: string) =>
      method === "Runtime.evaluate"
        ? { result: { value: nonce } }
        : { frameTree: { frame: { id: "unmapped-frame", loaderId: "document" } } },
    );
    recorder.onCdpEvent(
      contents as unknown as Electron.WebContents,
      "Runtime.executionContextCreated",
      {
        context: {
          id: 9,
          name: "Electron Isolated Context",
          auxData: { frameId: "unmapped-frame" },
        },
      },
    );
    ipc.emit("paseo:browser-recording-document", event(first), { nonce });
    await vi.waitFor(() => expect(cdp.send.mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((resolve) => setImmediate(resolve));
    ipc.emit("paseo:browser-recording-click", event(first), click);
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "interaction",
          frameAttribution: "unattributed",
          payload: expect.objectContaining({
            receivedAt: expect.any(Number),
            element: expect.objectContaining({ id: "submit" }),
          }),
        }),
      ),
    );
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({ reason: "interaction-frame-unattributed" }),
      }),
    );
    recorder.dispose();
  });
  it("rejects a frame claiming another frame's document and rejects oversized payloads", async () => {
    const { ipc, first, second, sink, recorder, event, nonce, click } = setup();
    ipc.emit("paseo:browser-recording-document", event(first), { nonce });
    ipc.emit("paseo:browser-recording-click", event(second), click);
    ipc.emit("paseo:browser-recording-click", event(first), {
      ...click,
      element: { ...click.element, label: "x".repeat(257) },
    });
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "interaction-frame-identity-conflict" }),
        }),
      ),
    );
    expect(
      sink.write.mock.calls.every(([value]) => (value as { kind: string }).kind !== "interaction"),
    ).toBe(true);
    recorder.dispose();
  });
  it("ignores clicks from unrelated browser contents", async () => {
    const { ipc, first, sink, recorder, event, click } = setup();
    const other = { id: 11, isDestroyed: () => false, mainFrame: { framesInSubtree: [first] } };
    ipc.emit("paseo:browser-recording-click", event(first, other), click);
    await Promise.resolve();
    expect(
      sink.write.mock.calls.every(([value]) => (value as { kind: string }).kind !== "interaction"),
    ).toBe(true);
    recorder.dispose();
  });
});
