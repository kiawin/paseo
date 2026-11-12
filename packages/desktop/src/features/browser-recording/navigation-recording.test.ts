import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { createRecordingBridge } from "./ipc.js";
import { BrowserRecordingStore } from "./store.js";

it("persists browser membership and document and same-document navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-navigation-"));
  const store = new BrowserRecordingStore(root);
  const registry = new PaseoBrowserWebviewRegistry();
  registry.registerWebContents({ browserId: "root", webContentsId: 101, hostWebContentsId: 10 });
  registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
  const coordinator = new BrowserRecordingCoordinator(registry, () => true);
  const bridge = createRecordingBridge({
    registry,
    coordinator,
    store,
    video: { start: async () => {} },
    ensureInteractionReady: async () => true,
    isTrustedHost: () => true,
    notify: () => {},
    getResponseBody: async () => ({ body: "", base64Encoded: false }),
    getRequestPostData: async () => ({ postData: "" }),
  });
  try {
    const caller = { senderId: 10, mainFrame: true };
    const recording = await bridge.start(caller, { browserId: "root" });
    const member = coordinator.getMembership(101)!;
    const popup = coordinator.addPopupFromOpen({
      openerWebContentsId: 101,
      popupWebContentsId: 102,
    });
    coordinator.registerFrame({ webContentsId: 101, frameId: "frame", documentId: "document" });
    bridge.onCdpEvent(101, "Page.frameNavigated", {
      frame: { id: "frame", loaderId: "document", url: "https://example.test/page" },
    });
    bridge.onCdpEvent(101, "Page.navigatedWithinDocument", {
      frameId: "frame",
      url: "https://example.test/page#section",
      navigationType: "historyApi",
    });
    await bridge.stop(caller, { recordingId: recording.recordingId });
    const events = (await store.readEvents(recording.recordingId)).events;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "membership",
          memberId: member.memberId,
          payload: expect.objectContaining({ browserId: "root", parentMemberId: null }),
        }),
        expect.objectContaining({
          kind: "membership",
          memberId: popup.memberId,
          payload: expect.objectContaining({ browserId: null, parentMemberId: member.memberId }),
        }),
        expect.objectContaining({
          kind: "navigation",
          memberId: member.memberId,
          frameId: "frame",
          documentId: "document",
          payload: expect.objectContaining({ url: "https://example.test/page", type: "document" }),
        }),
        expect.objectContaining({
          kind: "navigation",
          memberId: member.memberId,
          frameId: "frame",
          documentId: "document",
          payload: expect.objectContaining({
            url: "https://example.test/page#section",
            type: "same-document",
          }),
        }),
      ]),
    );
  } finally {
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("saves an interrupted recording when debugger recovery fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-debugger-failure-"));
  const store = new BrowserRecordingStore(root);
  const registry = new PaseoBrowserWebviewRegistry();
  registry.registerWebContents({ browserId: "root", webContentsId: 101, hostWebContentsId: 10 });
  registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
  const coordinator = new BrowserRecordingCoordinator(registry, () => true);
  const bridge = createRecordingBridge({
    registry,
    coordinator,
    store,
    video: { start: async () => {} },
    ensureInteractionReady: async () => true,
    isTrustedHost: () => true,
    notify: () => {},
    getResponseBody: async () => ({ body: "", base64Encoded: false }),
    getRequestPostData: async () => ({ postData: "" }),
  });
  try {
    const caller = { senderId: 10, mainFrame: true };
    const recording = await bridge.start(caller, { browserId: "root" });
    bridge.reportCaptureFailure(recording.recordingId, new Error("Debugger recovery failed"));
    await vi.waitFor(async () =>
      expect((await store.readMetadata(recording.recordingId)).status).toBe("interrupted"),
    );
    const saved = await store.readMetadata(recording.recordingId);
    expect(saved.captureErrors).toContain("Error: Debugger recovery failed");
  } finally {
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
