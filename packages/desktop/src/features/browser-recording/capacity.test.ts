import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { createRecordingBridge } from "./ipc.js";
import { BrowserRecordingStore } from "./store.js";

it("rejects a seventeenth simultaneous recording without affecting the existing ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-recording-capacity-"));
  const store = new BrowserRecordingStore(root);
  const registry = new PaseoBrowserWebviewRegistry();
  for (let index = 0; index < 17; index++) {
    registry.registerWebContents({
      browserId: `browser-${index}`,
      webContentsId: 101 + index,
      hostWebContentsId: 10,
    });
    registry.registerWorkspace({ browserId: `browser-${index}`, workspaceId: "workspace" });
  }
  const coordinator = new BrowserRecordingCoordinator(registry, () => false);
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
    const started = [];
    for (let index = 0; index < 16; index++)
      started.push(await bridge.start(caller, { browserId: `browser-${index}` }));
    await expect(bridge.start(caller, { browserId: "browser-16" })).rejects.toThrow(
      "Recording limit reached",
    );
    expect(
      await bridge.active({ senderId: 20, mainFrame: true }, { browserId: "browser-0" }),
    ).toBeNull();
    for (const [index, entry] of started.entries())
      expect(await bridge.active(caller, { browserId: `browser-${index}` })).toMatchObject({
        recordingId: entry.recordingId,
        status: "recording",
      });
  } finally {
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
