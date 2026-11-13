import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { BrowserRecordingStore } from "./store.js";
import { createRecordingBridge } from "./ipc.js";

describe("recording audio bridge", () => {
  it("persists the audio choice, starts the recorder with it and reports unavailable descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-audio-bridge-"));
    try {
      const store = new BrowserRecordingStore(root);
      const registry = new PaseoBrowserWebviewRegistry();
      registry.registerWebContents({
        browserId: "root",
        webContentsId: 101,
        hostWebContentsId: 10,
      });
      registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
      const coordinator = new BrowserRecordingCoordinator(registry, () => false);
      const start = vi.fn(async (_id: string, _options?: { audio?: boolean }) => {});
      const notify = vi.fn();
      const bridge = createRecordingBridge({
        registry,
        coordinator,
        store,
        video: { start },
        ensureInteractionReady: async () => {},
        isTrustedHost: (id) => id === 10,
        notify,
        getResponseBody: async () => ({ body: "", base64Encoded: false }),
        getRequestPostData: async () => ({ postData: "" }),
      });
      const owner = { senderId: 10, mainFrame: true };
      const { recordingId } = await bridge.start(owner, { browserId: "root", audio: true });
      expect(start).toHaveBeenCalledWith(recordingId, { audio: true });
      expect(await store.readMetadata(recordingId)).toMatchObject({ audioRequested: true });
      bridge.reportAudioStatus({
        recordingId,
        memberId: "popup",
        status: "unavailable",
        reason: "denied",
      });
      bridge.reportAudioStatus({ recordingId, memberId: "root", status: "captured" });
      expect(await bridge.active(owner, { browserId: "root" })).toMatchObject({
        audioRequested: true,
        audioStatus: "unavailable",
        audioReason: "denied",
      });
      expect(notify).toHaveBeenCalledWith(
        10,
        expect.objectContaining({ recordingId, audioStatus: "unavailable", audioReason: "denied" }),
      );
      const stopping = bridge.stop(owner, { recordingId });
      bridge.reportAudioStatus({
        recordingId,
        memberId: "popup",
        status: "unavailable",
        reason: "ended",
      });
      await stopping;
      expect(await store.readMetadata(recordingId)).toMatchObject({
        audioRequested: true,
        audioStatus: "unavailable",
        audioReason: "ended",
      });
      await bridge.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
