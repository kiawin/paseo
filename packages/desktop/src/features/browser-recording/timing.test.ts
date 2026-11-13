import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { createRecordingBridge } from "./ipc.js";
import { BrowserRecordingStore } from "./store.js";

it("uses request observation time without wallTime and anchors gap summaries to their start", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-recording-timing-"));
  const store = new BrowserRecordingStore(root);
  const registry = new PaseoBrowserWebviewRegistry();
  registry.registerWebContents({ browserId: "root", webContentsId: 101, hostWebContentsId: 10 });
  registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
  const coordinator = new BrowserRecordingCoordinator(registry, () => false);
  const bridge = createRecordingBridge({
    registry,
    coordinator,
    store,
    video: { start: async () => {} },
    ensureInteractionReady: async () => true,
    isTrustedHost: () => true,
    notify: () => {},
    getResponseBody: async () => ({ body: "ok", base64Encoded: false }),
    getRequestPostData: async () => ({ postData: "" }),
  });
  try {
    const caller = { senderId: 10, mainFrame: true };
    const recording = await bridge.start(caller, { browserId: "root" });
    const metadata = await store.readMetadata(recording.recordingId);
    bridge.onCdpEvent(101, "Network.requestWillBeSent", {
      requestId: "slow",
      request: { url: "https://fixture.test/slow", method: "GET", headers: {} },
      timestamp: 1,
    });
    bridge.onCdpEvent(101, "Network.responseReceived", {
      requestId: "missing-1",
      response: { status: 200, headers: {} },
    });
    bridge.onCdpEvent(101, "Network.responseReceived", {
      requestId: "missing-2",
      response: { status: 200, headers: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    bridge.onCdpEvent(101, "Network.loadingFailed", {
      requestId: "slow",
      errorText: "failed",
      timestamp: 2,
    });
    await bridge.stop(caller, { recordingId: recording.recordingId });
    const events = (await store.readEvents(recording.recordingId)).events;
    const network = events.find(
      (event) =>
        event.kind === "network" && (event.payload as { requestId?: string }).requestId === "slow",
    );
    expect(network?.timelineMs).toBeLessThan(Date.now() - metadata.startedAt - 100);
    const gaps = events.filter(
      (event) =>
        event.kind === "gap" &&
        (event.payload as { reason?: string }).reason === "event-without-request",
    );
    expect(gaps).toHaveLength(2);
    expect(gaps[1].timelineMs).toBe(gaps[0].timelineMs);
  } finally {
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
