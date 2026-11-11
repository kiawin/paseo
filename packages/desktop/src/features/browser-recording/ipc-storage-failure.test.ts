import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { BrowserRecordingStore } from "./store.js";
import { createRecordingBridge } from "./ipc.js";

describe("recording storage interruption", () => {
  it("stops and reports quota exhaustion while capture is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-live-quota-"));
    try {
      const store = new BrowserRecordingStore(root, { maxStorageBytes: 512 });
      const registry = new PaseoBrowserWebviewRegistry();
      registry.registerWebContents({
        browserId: "root",
        webContentsId: 101,
        hostWebContentsId: 10,
      });
      registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
      const coordinator = new BrowserRecordingCoordinator(registry, () => false);
      const notify = vi.fn();
      const bridge = createRecordingBridge({
        registry,
        coordinator,
        store,
        video: { start: async () => {} },
        ensureInteractionReady: async () => {},
        isTrustedHost: (id) => id === 10,
        notify,
        getResponseBody: async () => ({ body: "", base64Encoded: false }),
        getRequestPostData: async () => ({ postData: "" }),
      });
      const { recordingId } = await bridge.start(
        { senderId: 10, mainFrame: true },
        { browserId: "root" },
      );
      await expect(
        coordinator.emit({
          webContentsId: 101,
          kind: "interaction",
          payload: { text: "x".repeat(2000) },
        }),
      ).rejects.toThrow(/quota/i);
      await vi.waitFor(async () =>
        expect((await store.readMetadata(recordingId)).status).toBe("interrupted"),
      );
      expect(notify).toHaveBeenCalledWith(
        10,
        expect.objectContaining({ recordingId, status: "interrupted", reason: "quota" }),
      );
      expect((await store.readMetadata(recordingId)).captureErrors?.join(" ")).toMatch(/quota/i);
      await bridge.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
