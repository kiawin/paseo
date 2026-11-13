import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";

const electron = vi.hoisted(() => {
  function makeContents(id: number) {
    return {
      id,
      isDestroyed: () => false,
      once: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
  }
  const contents = new Map<number, ReturnType<typeof makeContents>>();
  let nextId = 500;
  class FakeWindow {
    webContents: ReturnType<typeof makeContents>;
    constructor() {
      const id = nextId++;
      this.webContents = makeContents(id);
      contents.set(id, this.webContents);
    }
  }
  return { contents, FakeWindow };
});
const cdp = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: electron.FakeWindow,
  webContents: { fromId: (id: number) => electron.contents.get(id) ?? null },
}));
vi.mock("../browser-automation/ipc.js", () => ({ getSharedCdpSession: cdp.get }));
import { createBrowserRecordingLifecycle } from "./lifecycle.js";

function setup() {
  const registry = new PaseoBrowserWebviewRegistry();
  const root = new electron.FakeWindow().webContents;
  registry.registerWebContents({ browserId: "root", webContentsId: root.id, hostWebContentsId: 1 });
  registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
  const messages: Array<{ onMessage: (message: unknown) => void }> = [];
  const events: unknown[] = [];
  const methods: string[] = [];
  const sessionIds: Array<string | undefined> = [];
  const errors: unknown[] = [];
  const consumer = {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    enableAutoAttach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({ frameTree: {} }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  cdp.get.mockImplementation(() => ({
    createConsumer: (callbacks: unknown) => {
      messages.push(callbacks as { onMessage: (message: unknown) => void });
      return consumer;
    },
    primeDomain: vi.fn().mockResolvedValue(undefined),
  }));
  const lifecycle = createBrowserRecordingLifecycle({
    registry,
    onTabOpen: () => {},
    onPopup: () => {},
    onError: (error) => errors.push(error),
    onCdpEvent: (_contents, method, params, sessionId) => {
      methods.push(method);
      if (method === "Page.frameNavigated" || method === "Page.frameDetached") {
        sessionIds.push(sessionId);
        events.push(
          lifecycle.coordinator.getFrame({
            webContentsId: root.id,
            frameId:
              method === "Page.frameDetached"
                ? String(params.frameId)
                : (params.frame as { id: string }).id,
          }),
        );
      }
    },
  });
  const sink = { write: vi.fn(async () => {}) };
  const member = lifecycle.coordinator.start({
    recordingId: "recording",
    hostWebContentsId: 1,
    browserId: "root",
    sink,
  });
  return { lifecycle, root, registry, messages, events, sessionIds, methods, errors, sink, member };
}

beforeEach(() => {
  electron.contents.clear();
  cdp.get.mockReset();
});
describe("recording lifecycle failure paths", () => {
  it("registers a frame before delivering its navigation to a recorder", () => {
    const { messages, events, sessionIds } = setup();
    messages[0].onMessage({
      method: "Page.frameNavigated",
      sessionId: "child-session",
      params: { frame: { id: "frame", loaderId: "doc" } },
    });
    expect(events).toEqual([{ frameId: "frame", documentId: "doc" }]);
    expect(sessionIds).toEqual(["child-session"]);
  });
  it("delivers frame detachment before clearing its document identity", () => {
    const { messages, events, lifecycle, root } = setup();
    messages[0].onMessage({
      method: "Page.frameNavigated",
      params: { frame: { id: "frame", loaderId: "doc" } },
    });
    messages[0].onMessage({ method: "Page.frameDetached", params: { frameId: "frame" } });
    expect(events).toEqual([
      { frameId: "frame", documentId: "doc" },
      { frameId: "frame", documentId: "doc" },
    ]);
    expect(lifecycle.coordinator.getFrame({ webContentsId: root.id, frameId: "frame" })).toBeNull();
  });
  it("forwards unsupported worker target events as well as reporting a gap", async () => {
    const { messages, methods, sink } = setup();
    messages[0].onMessage({
      method: "Target.attachedToTarget",
      params: { sessionId: "worker", targetInfo: { type: "service_worker" } },
    });
    expect(methods).toContain("Target.attachedToTarget");
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "unsupported-child-target" }),
        }),
      ),
    );
  });
  it("reports a failed guest replacement without losing the browser registration", async () => {
    const { registry, root, lifecycle, sink, errors } = setup();
    const replacement = new electron.FakeWindow().webContents;
    registry.registerWebContents({
      browserId: "root",
      webContentsId: replacement.id,
      hostWebContentsId: 1,
    });
    registry.registerWorkspace({ browserId: "root", workspaceId: "other" });
    lifecycle.attached(1, "root");
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "replacement-failed" }),
        }),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(lifecycle.coordinator.getBrowserMembership(1, "root")?.webContentsId).toBe(root.id);
  });
  it("removes a popup membership and records a gap if initial instrumentation throws", async () => {
    const { lifecycle, root, errors, sink } = setup();
    lifecycle.installWindowOpenHandler({
      contents: root as unknown as Electron.WebContents,
      sourceContents: root as unknown as Electron.WebContents,
      mainWindow: new electron.FakeWindow() as unknown as Electron.BrowserWindow,
    });
    cdp.get.mockImplementation(() => {
      throw new Error("injected setup failure");
    });
    const handler = root.setWindowOpenHandler.mock.calls[0][0];
    const decision = handler({
      url: "https://fixture.test",
      disposition: "new-window",
      frameName: "popup",
      features: "width=200",
      postBody: null,
    });
    const child = decision.createWindow({});
    expect(lifecycle.coordinator.getMembership(child.id)).toBeNull();
    await vi.waitFor(() =>
      expect(sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "gap",
          payload: expect.objectContaining({ reason: "popup-admission-failed" }),
        }),
      ),
    );
    expect(errors).toHaveLength(1);
  });
});
