import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { BrowserRecordingStore } from "./store.js";

const fake = vi.hoisted(() => ({ contents: new Map<number, unknown>(), send: vi.fn() }));
vi.mock("electron", () => ({
  ipcMain: new EventEmitter(),
  webContents: { fromId: (id: number) => fake.contents.get(id) ?? null },
}));
vi.mock("../browser-automation/ipc.js", () => ({
  getSharedCdpSession: () => ({
    runtimeContextSnapshot: () => ({ contexts: [], dropped: 0 }),
    createConsumer: () => ({
      sendCommand: fake.send,
      release: vi.fn().mockResolvedValue(undefined),
    }),
  }),
}));
import { createInteractionRecorder } from "./interaction-recorder.js";

let root: string;
beforeEach(async () => {
  fake.contents.clear();
  fake.send.mockReset();
  root = await mkdtemp(join(tmpdir(), "paseo-interaction-storage-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("interaction event storage", () => {
  it("persists an actual interaction-recorder event through the coordinator", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create({
      recordingId: "recording",
      workspaceId: "workspace",
      startedAt: 1,
      status: "recording",
    });
    const frame = { processId: 1, frameToken: "sender-frame", detached: false, send: vi.fn() };
    const contents = { id: 10, isDestroyed: () => false, mainFrame: { framesInSubtree: [frame] } };
    fake.contents.set(contents.id, contents);
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      browserId: "root",
      webContentsId: contents.id,
      hostWebContentsId: 1,
    });
    registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
    const coordinator = new BrowserRecordingCoordinator(registry, () => false);
    const ipc = new EventEmitter();
    const errors: unknown[] = [];
    const interactions = createInteractionRecorder({
      coordinator,
      ipc: ipc as unknown as Electron.IpcMain,
      onError: (error) => errors.push(error),
    });
    interactions.registerIpc();
    coordinator.start({
      recordingId: "recording",
      hostWebContentsId: 1,
      browserId: "root",
      sink: { write: (event) => store.appendEvent("recording", event) },
    });
    coordinator.registerFrame({ webContentsId: 10, frameId: "cdp-frame", documentId: "document" });
    const nonce = "a".repeat(32);
    fake.send.mockImplementation(async (method: string) =>
      method === "Runtime.evaluate"
        ? { result: { value: nonce } }
        : { frameTree: { frame: { id: "cdp-frame", loaderId: "document" } } },
    );
    interactions.onCdpEvent(
      contents as unknown as Electron.WebContents,
      "Runtime.executionContextCreated",
      { context: { id: 1, name: "Electron Isolated Context", auxData: { frameId: "cdp-frame" } } },
    );
    const sender = { sender: contents, senderFrame: frame };
    ipc.emit("paseo:browser-recording-document", sender, { nonce });
    await vi.waitFor(() => expect(interactions.getFrameCount(contents.id)).toBe(1));
    ipc.emit("paseo:browser-recording-click", sender, {
      nonce,
      at: 1000,
      activation: "pointer",
      button: "primary",
      modifiers: { alt: false, control: false, meta: false, shift: false },
      element: {
        tag: "button",
        id: "save",
        name: "",
        role: "",
        label: "Save",
        href: "",
        truncated: false,
      },
    });
    await coordinator.stop("recording");
    const result = await store.readEvents("recording");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "interaction",
      frameId: "cdp-frame",
      documentId: "document",
      payload: { element: { id: "save", label: "Save" }, origin: "unknown" },
    });
    expect(errors).toEqual([]);
    interactions.dispose();
  });
});
