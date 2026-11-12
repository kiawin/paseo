import { beforeEach, expect, it, vi } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";

const mock = vi.hoisted(() => ({ contents: new Map<number, unknown>(), get: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  webContents: { fromId: (id: number) => mock.contents.get(id) },
}));
vi.mock("../browser-automation/ipc.js", () => ({ getSharedCdpSession: mock.get }));
import { createBrowserRecordingLifecycle } from "./lifecycle.js";

function setup(recover: () => Promise<void>) {
  const root = { id: 42, isDestroyed: () => false, once: vi.fn(), on: vi.fn() };
  mock.contents.set(root.id, root);
  const registry = new PaseoBrowserWebviewRegistry();
  registry.registerWebContents({ browserId: "root", webContentsId: root.id, hostWebContentsId: 1 });
  registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
  let detach = () => {};
  const consumer = {
    recover: vi.fn(recover),
    enableDomain: vi.fn().mockResolvedValue(undefined),
    enableAutoAttach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi
      .fn()
      .mockResolvedValue({ frameTree: { frame: { id: "fresh", loaderId: "new" } } }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  mock.get.mockReturnValue({
    createConsumer: (callbacks: { onDetach: () => void }) => {
      detach = callbacks.onDetach;
      return consumer;
    },
  });
  const sink = { write: vi.fn(async () => {}) };
  const failure = vi.fn();
  const event = vi.fn();
  const lifecycle = createBrowserRecordingLifecycle({
    registry,
    onTabOpen: () => {},
    onPopup: () => {},
    onError: () => {},
    onCaptureFailure: failure,
    onCdpEvent: event,
  });
  lifecycle.coordinator.start({
    recordingId: "recording",
    hostWebContentsId: 1,
    browserId: "root",
    sink,
  });
  return { lifecycle, root, consumer, sink, failure, event, detach: () => detach() };
}

beforeEach(() => {
  mock.contents.clear();
  mock.get.mockReset();
});
it("restores capture and frame identities after a debugger disconnect", async () => {
  let resume!: () => void;
  const recovery = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const { lifecycle, root, consumer, sink, event, detach } = setup(() => recovery);
  await vi.waitFor(() => expect(consumer.sendCommand).toHaveBeenCalled());
  lifecycle.coordinator.registerFrame({
    webContentsId: root.id,
    frameId: "stale",
    documentId: "old",
  });
  detach();
  expect(lifecycle.coordinator.getFrame({ webContentsId: root.id, frameId: "stale" })).toBeNull();
  expect(event).toHaveBeenCalledWith(root, "Paseo.debuggerDetached", {});
  resume();
  await vi.waitFor(() =>
    expect(lifecycle.coordinator.getFrame({ webContentsId: root.id, frameId: "fresh" })).toEqual({
      frameId: "fresh",
      documentId: "new",
    }),
  );
  await vi.waitFor(() =>
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({ reason: "debugger-recovered" }),
      }),
    ),
  );
});
it("interrupts capture when debugger recovery fails", async () => {
  const { consumer, failure, detach } = setup(async () => {
    throw new Error("attach failed");
  });
  await vi.waitFor(() => expect(consumer.sendCommand).toHaveBeenCalled());
  detach();
  await vi.waitFor(() =>
    expect(failure).toHaveBeenCalledWith(
      "recording",
      expect.objectContaining({ message: "attach failed" }),
    ),
  );
});
