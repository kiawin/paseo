import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { BrowserRecordingStore } from "./store.js";
import { createRecordingBridge } from "./ipc.js";

describe("recording storage interruption", () => {
  it("interrupts capture when an event rollback fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-rollback-failure-"));
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
      const notify = vi.fn();
      const bridge = createRecordingBridge({
        registry,
        coordinator,
        store,
        video: { start: async () => {} },
        ensureInteractionReady: async () => {},
        isTrustedHost: () => true,
        notify,
        getResponseBody: async () => ({ body: "", base64Encoded: false }),
        getRequestPostData: async () => ({ postData: "" }),
      });
      const { recordingId } = await bridge.start(
        { senderId: 10, mainFrame: true },
        { browserId: "root" },
      );
      const rollback = Object.assign(new Error("rollback denied"), {
        code: "RECORDING_EVENT_ROLLBACK_FAILED",
      });
      const combined = Object.assign(
        new AggregateError(
          [rollback, new Error("event close denied")],
          "Recording event write and close failed",
          { cause: rollback },
        ),
        { code: "RECORDING_EVENT_ROLLBACK_FAILED" },
      );
      vi.spyOn(store, "appendEvent").mockRejectedValueOnce(combined);
      await expect(
        coordinator.emit({ webContentsId: 101, kind: "interaction", payload: { type: "click" } }),
      ).rejects.toThrow("Recording event write and close failed");
      await vi.waitFor(async () =>
        expect((await store.readMetadata(recordingId)).status).toBe("interrupted"),
      );
      expect((await store.readMetadata(recordingId)).captureErrors?.join(" ")).toContain(
        "rollback denied",
      );
      await bridge.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
