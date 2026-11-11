const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(50);
  }
  assert.fail(message);
}
module.exports = {
  name: "bridge",
  phases: ["single"],
  async run({ helpers }) {
    const { ipcMain } = require("electron");
    const {
      PaseoBrowserWebviewRegistry,
    } = require("../dist/features/browser-webviews/registry.js");
    const {
      createBrowserRecordingLifecycle,
    } = require("../dist/features/browser-recording/lifecycle.js");
    const {
      createInteractionRecorder,
    } = require("../dist/features/browser-recording/interaction-recorder.js");
    const { BrowserRecordingStore } = require("../dist/features/browser-recording/store.js");
    const {
      createVideoCaptureManager,
    } = require("../dist/features/browser-recording/video-capture.js");
    const { createRecordingBridge } = require("../dist/features/browser-recording/ipc.js");
    const {
      isTrustedRecordingUrl,
      registerRecordingIpc,
    } = require("../dist/features/browser-recording/register-ipc.js");
    const {
      browserRecordingPopupOptions,
    } = require("../dist/features/browser-recording/popup-options.js");
    const { getSharedCdpSession } = require("../dist/features/browser-automation/ipc.js");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-recording-bridge-"));
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith("/harness")) {
        response.setHeader("content-type", "text/html");
        response.end(fs.readFileSync(path.join(helpers.harnessRoot, "index.html")));
      } else if (request.url?.startsWith("/api")) {
        request.resume();
        request.on("end", () => response.end("fixture-response"));
      } else if (request.url === "/redirect") {
        response.writeHead(302, { location: "/api" });
        response.end();
      } else {
        response.setHeader("content-type", "text/html");
        response.end(
          "<!doctype html><button id='go' style='position:absolute;left:10px;top:10px;width:150px;height:40px'>Capture click</button>",
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const handle = helpers.createInactiveHarnessWindow({
      width: 800,
      height: 600,
      webPreferences: {
        preload: path.join(__dirname, "../dist/preload.js"),
        webviewTag: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    const host = handle.win;
    const registry = new PaseoBrowserWebviewRegistry();
    const errors = [];
    const popups = [];
    let largeInlineChars = 0;
    let interaction;
    let bridge;
    const lifecycle = createBrowserRecordingLifecycle({
      registry,
      onTabOpen: () => {},
      onPopup: (popup) => popups.push(popup),
      popupOptions: (window) => ({
        ...browserRecordingPopupOptions(window, helpers.guestPreloadPath),
        show: false,
      }),
      onError: (error) => errors.push(error),
      onCdpEvent: (contents, method, params, sessionId) => {
        if (method === "Network.requestWillBeSent" && params.request?.url?.includes("large=1")) {
          const request = params.request;
          largeInlineChars =
            (typeof request.postData === "string" ? request.postData.length : 0) +
            (Array.isArray(request.postDataEntries)
              ? request.postDataEntries.reduce(
                  (total, entry) =>
                    total + (typeof entry.bytes === "string" ? entry.bytes.length : 0),
                  0,
                )
              : 0);
        }
        interaction?.onCdpEvent(contents, method, params, sessionId);
        bridge?.onCdpEvent(contents.id, method, params, sessionId);
      },
    });
    interaction = createInteractionRecorder({
      coordinator: lifecycle.coordinator,
      ipc: ipcMain,
      onError: (error) => errors.push(error),
    });
    interaction.registerIpc();
    const store = new BrowserRecordingStore(directory);
    const video = createVideoCaptureManager({
      coordinator: lifecycle.coordinator,
      store,
      onError: (error) => errors.push(error),
    });
    bridge = createRecordingBridge({
      registry,
      coordinator: lifecycle.coordinator,
      store,
      video,
      ensureInteractionReady: (id) => lifecycle.ready(id),
      isTrustedHost: (id, url) =>
        id === host.webContents.id && isTrustedRecordingUrl(url ?? "", false, origin),
      notify: (id, state) => {
        if (id === host.webContents.id) host.webContents.send("paseo:recording:state", state);
      },
      createBodyReader: (id) => lifecycle.retainNetwork(id),
      getResponseBody: (id, requestId, sessionId) =>
        lifecycle.backgroundCommand(
          id,
          "Network.getResponseBody",
          { requestId },
          sessionId ?? undefined,
        ),
      getRequestPostData: (id, requestId, sessionId) =>
        lifecycle.backgroundCommand(
          id,
          "Network.getRequestPostData",
          { requestId },
          sessionId ?? undefined,
        ),
    });
    const unregisterIpc = registerRecordingIpc(ipcMain, bridge);
    try {
      helpers.installHarnessWebviewGuards(host, { preloadPath: helpers.guestPreloadPath });
      const tracker = helpers.trackAttachedGuests(host);
      const harnessUrl = new URL("/harness", origin);
      harnessUrl.search = new URLSearchParams({
        webviewCount: "0",
        permanentParkingState: "p1-overflow-1x1",
        targetUrl: origin,
      }).toString();
      await host.loadURL(harnessUrl.toString());
      await helpers.waitForInactiveReveal(handle, "recording bridge host");
      const { guest } = await helpers.appendPermanentWebview({
        win: host,
        tracker,
        state: { id: "p1-overflow-1x1" },
        sourceUrl: origin,
      });
      await helpers.waitForGuestLoad(guest);
      registry.registerWebContents({
        browserId: "root",
        webContentsId: guest.id,
        hostWebContentsId: host.webContents.id,
      });
      registry.registerWorkspace({ browserId: "root", workspaceId: "fixture" });
      lifecycle.installWindowOpenHandler({
        contents: guest,
        sourceContents: guest,
        mainWindow: host,
      });
      const recording = await host.webContents.executeJavaScript(
        "window.paseoDesktop.recording.start({browserId: 'root'})",
      );
      const activeRecording = await host.webContents.executeJavaScript(
        "window.paseoDesktop.recording.active({browserId: 'root'})",
      );
      assert.equal(activeRecording.recordingId, recording.recordingId);
      assert.equal(activeRecording.status, "recording");
      assert.equal(
        await host.webContents.executeJavaScript(
          "window.paseoDesktop.recording.active({browserId: 'unknown'})",
        ),
        null,
      );
      await host.webContents.executeJavaScript(`window.recordingStates = [];
        window.paseoDesktop.recording.onState(state => window.recordingStates.push(state)); true;`);
      const reservation = lifecycle.coordinator.reserveTabOpen(guest.id);
      const child = await helpers.appendPermanentWebview({
        win: host,
        tracker,
        state: { id: "p1-overflow-1x1" },
        sourceUrl: origin,
      });
      await helpers.waitForGuestLoad(child.guest);
      registry.registerWebContents({
        browserId: reservation.browserId,
        webContentsId: child.guest.id,
        hostWebContentsId: host.webContents.id,
      });
      registry.registerWorkspace({ browserId: reservation.browserId, workspaceId: "fixture" });
      lifecycle.coordinator.claimTabOpen({
        ...reservation,
        hostWebContentsId: host.webContents.id,
      });
      const childState = await host.webContents.executeJavaScript(
        `window.paseoDesktop.recording.active({browserId: ${JSON.stringify(reservation.browserId)}})`,
      );
      assert.equal(
        childState.recordingId,
        recording.recordingId,
        "descendant belongs to root recording",
      );
      assert.equal(childState.status, "recording");
      const notifications = await host.webContents.executeJavaScript("window.recordingStates");
      assert(
        notifications.some(
          (state) => state.browserId === reservation.browserId && state.status === "recording",
        ),
        "descendant receives recording state",
      );
      assert.equal(
        await guest.executeJavaScript("typeof window.paseoDesktop"),
        "undefined",
        "guest receives no desktop bridge",
      );
      await eventually(() => interaction.getFrameCount(guest.id) > 0, "interaction frame is ready");
      guest.sendInputEvent({ type: "mouseDown", x: 30, y: 25, button: "left", clickCount: 1 });
      guest.sendInputEvent({ type: "mouseUp", x: 30, y: 25, button: "left", clickCount: 1 });
      await guest.executeJavaScript(
        "fetch('/api',{method:'POST',body:'fixture-request'}).then(r=>r.text())",
      );
      const automation = await getSharedCdpSession(guest).sendCommand("Runtime.evaluate", {
        expression: "40 + 2",
        returnByValue: true,
      });
      assert.equal(automation.result.value, 42, "automation coexists with recording");
      await guest.executeJavaScript("fetch('/redirect').then(r=>r.text())");
      await guest.executeJavaScript(
        `window.open(${JSON.stringify(`${origin}/popup`)}, '_blank', 'width=320,height=240'); true`,
      );
      await eventually(
        () => popups.length === 1 && lifecycle.coordinator.getMembership(popups[0].webContents.id),
        "popup is recorded",
      );
      const popup = popups[0];
      const popupMember = lifecycle.coordinator.getMembership(popup.webContents.id);
      await eventually(() => !popup.webContents.isLoading(), "popup is loaded");
      await popup.webContents.executeJavaScript(
        "fetch('/api',{method:'POST',body:'popup-request'}).then(r=>r.text())",
      );
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some(
            (event) =>
              event.kind === "network" &&
              event.memberId === popupMember.memberId &&
              event.payload.request.body.data === "popup-request",
          ),
        "popup traffic is recorded separately",
      );
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some(
            (event) => event.kind === "network" && event.payload.outcome === "redirected",
          ),
        "redirect hop is recorded",
      );
      await eventually(
        async () =>
          (await store.listMediaSegments(recording.recordingId)).some(
            (segment) => segment.streamId === popupMember.memberId,
          ),
        "popup video is recorded separately",
      );
      await guest.executeJavaScript(
        "fetch('/api?large=1',{method:'POST',body:new Blob([new Uint8Array(4 * 1024 * 1024)])}).then(r=>r.text())",
      );
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some(
            (event) => event.kind === "network" && event.payload.request.url.includes("large=1"),
          ),
        "large POST is recorded with a limitation",
      );
      const largeEvent = (await store.readEvents(recording.recordingId)).events.find(
        (event) => event.kind === "network" && event.payload.request.url.includes("large=1"),
      );
      assert.ok(
        ["truncated", "unavailable"].includes(largeEvent.payload.request.body.state),
        "large request body is explicitly limited",
      );
      assert.ok(
        largeInlineChars <= 1024 * 1024,
        `Chromium inlined too much POST data: ${largeInlineChars}`,
      );
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some(
            (event) => event.kind === "interaction",
          ),
        "click is persisted",
      );
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some((event) => {
            if (event.kind !== "network" || !event.payload.response) return false;
            const body = event.payload.response.body;
            if (!body.data || !["utf8", "base64"].includes(body.encoding)) return false;
            return (
              event.payload.request.body.data === "fixture-request" &&
              Buffer.from(body.data, body.encoding).toString("utf8") === "fixture-response"
            );
          }),
        "request and response are persisted",
      );
      await eventually(
        async () => (await store.listMediaSegments(recording.recordingId)).length > 0,
        "video is persisted",
      );
      const recordedEvents = (await store.readEvents(recording.recordingId)).events;
      const recordingStartedAt = (await store.readMetadata(recording.recordingId)).startedAt;
      const elapsed = Date.now() - recordingStartedAt;
      for (const kind of ["interaction", "network"]) {
        const event = recordedEvents.find((entry) => entry.kind === kind);
        assert.ok(
          Number.isFinite(event.timelineMs) &&
            event.timelineMs >= 0 &&
            event.timelineMs <= elapsed + 2000,
          `${kind} has a recording-relative time`,
        );
      }
      const timedNetwork = recordedEvents.find(
        (entry) => entry.kind === "network" && typeof entry.payload.wallTime === "number",
      );
      assert.ok(timedNetwork, "a network request has Chromium wall time");
      assert.equal(
        timedNetwork.timelineMs,
        Math.max(0, timedNetwork.payload.wallTime * 1000 - recordingStartedAt),
        "network time uses request start, not response write time",
      );
      await assert.rejects(
        bridge.readEvents(
          { senderId: guest.id, mainFrame: true },
          { recordingId: recording.recordingId, cursor: 0, maxBytes: 4096 },
        ),
      );
      await guest.executeJavaScript(
        "fetch('/api',{method:'POST',body:'tail-request'}).then(r=>r.text())",
      );
      await host.webContents.executeJavaScript(
        `window.paseoDesktop.recording.stop({recordingId: ${JSON.stringify(recording.recordingId)}})`,
      );
      assert.ok(
        (await store.readEvents(recording.recordingId)).events.some(
          (event) =>
            event.kind === "network" &&
            event.payload.request.body.data === "tail-request" &&
            event.payload.response?.body.state === "complete",
        ),
        "response arriving at stop is retained",
      );
      assert.equal((await store.readMetadata(recording.recordingId)).status, "complete");
      await host.loadURL(`http://localhost:${server.address().port}/`);
      await assert.rejects(
        host.webContents.executeJavaScript(
          "window.paseoDesktop.recording.list({workspaceId: 'fixture'})",
        ),
        /not authorized/,
      );
      assert.deepEqual(errors, []);
      return [{ group: "recording", check: "bridge", pass: true }];
    } finally {
      unregisterIpc();
      await bridge.dispose();
      await video.dispose();
      interaction.dispose();
      for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
      if (!host.isDestroyed()) host.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
};
