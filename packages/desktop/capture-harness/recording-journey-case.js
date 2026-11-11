const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  assert.fail(message);
}
async function measureTone(host, store, recordingId, streamId) {
  const all = (await store.listMediaSegments(recordingId))
    .filter((segment) => segment.streamId === streamId && segment.track === "combined")
    .sort((a, b) => a.startMs - b.startMs);
  assert.ok(all.length, "audio view has recorded media");
  const firstGeneration = all[0].generationId;
  const segments = all
    .filter((segment) => segment.generationId === firstGeneration)
    .sort((a, b) => a.sequence - b.sequence);
  const bytes = [];
  for (const segment of segments)
    bytes.push(
      Buffer.from((await store.readMediaSegment(recordingId, streamId, segment.segmentId)).bytes),
    );
  const encoded = Buffer.concat(bytes).toString("base64");
  return host.webContents.executeJavaScript(
    `new Promise((resolve) => {
    const video=document.createElement('video'); video.src='data:video/webm;base64,${encoded}';
    video.onloadedmetadata=async()=>{try {const stream=video.captureStream(); if(!stream.getAudioTracks().length)return resolve(null); const ctx=new AudioContext(); const analyser=ctx.createAnalyser(); analyser.fftSize=2048; ctx.createMediaStreamSource(stream).connect(analyser); await ctx.resume(); await video.play(); let a=0,b=0; for(let i=0;i<18;i++){await new Promise(r=>setTimeout(r,100));const data=new Uint8Array(analyser.frequencyBinCount);analyser.getByteFrequencyData(data); const sample=(frequency)=>{const bin=Math.round(frequency*analyser.fftSize/ctx.sampleRate);return Math.max(...data.slice(Math.max(0,bin-1),bin+2));};a=Math.max(a,sample(440));b=Math.max(b,sample(660));} await ctx.close();resolve({a,b})}catch{return resolve(null)}}; video.onerror=()=>resolve(null);setTimeout(()=>resolve(null),6000);
  })`,
    true,
  );
}
module.exports = {
  name: "journey",
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
      browserRecordingPopupOptions,
    } = require("../dist/features/browser-recording/popup-options.js");
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith("/api")) {
        response.end("response");
        return;
      }
      response.setHeader("content-type", "text/html");
      if (request.url === "/frame")
        response.end("<!doctype html><button>Frame</button><script>fetch('/api?frame=1')</script>");
      else response.end("<!doctype html><button id='root'>Root</button>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-recording-journey-"));
    const handle = helpers.createInactiveHarnessWindow({
      width: 800,
      height: 600,
      webPreferences: {
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
    let interaction;
    let bridge;
    let oversizedRequestId;
    let failedBodyRequestId;
    const requestPostCommands = [];
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
        if (method === "Network.requestWillBeSent" && params.request?.url?.includes("oversized=1"))
          oversizedRequestId = params.requestId;
        if (
          method === "Network.requestWillBeSent" &&
          params.request?.url?.includes("body-failure=1")
        )
          failedBodyRequestId = params.requestId;
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
      onAudioStatus: (value) => bridge?.reportAudioStatus(value),
    });
    bridge = createRecordingBridge({
      registry,
      coordinator: lifecycle.coordinator,
      store,
      video,
      ensureInteractionReady: (id) => lifecycle.ready(id),
      isTrustedHost: (id) => id === host.webContents.id,
      notify: () => {},
      createBodyReader: (id) => {
        const reader = lifecycle.retainNetwork(id);
        return {
          ...reader,
          getResponseBody: (requestId, sessionId) =>
            requestId === failedBodyRequestId
              ? Promise.reject(new Error("synthetic body failure"))
              : reader.getResponseBody(requestId, sessionId),
        };
      },
      getResponseBody: (id, requestId, sessionId) => {
        if (requestId === failedBodyRequestId)
          return Promise.reject(new Error("synthetic body failure"));
        return lifecycle.backgroundCommand(
          id,
          "Network.getResponseBody",
          { requestId },
          sessionId ?? undefined,
        );
      },
      getRequestPostData: (id, requestId, sessionId) =>
        lifecycle.backgroundCommand(
          id,
          "Network.getRequestPostData",
          { requestId },
          sessionId ?? undefined,
        ),
    });
    try {
      helpers.installHarnessWebviewGuards(host, { preloadPath: helpers.guestPreloadPath });
      const tracker = helpers.trackAttachedGuests(host);
      const attached = tracker.waitForAttachedGuests(2);
      const partition = `persist:paseo-recording-journey-${Date.now()}`;
      await helpers.withTimeout(
        host.loadFile(path.join(helpers.harnessRoot, "index.html"), {
          query: { webviewCount: "0", targetUrl: origin },
        }),
        "journey host load",
      );
      await helpers.waitForInactiveReveal(handle, "recording journey host");
      await host.webContents.executeJavaScript(`(() => {
        const host = document.getElementById('paseo-browser-resident-webviews');
        for (const id of ['root', 'unrelated']) {
          const webview = document.createElement('webview');
          webview.setAttribute('data-paseo-browser-id', id);
          webview.setAttribute('partition', ${JSON.stringify(partition)});
          webview.setAttribute('allowpopups', 'true');
          webview.src = ${JSON.stringify(origin)};
          host.appendChild(webview);
        }
      })()`);
      const guests = await helpers.withTimeout(attached, "journey guests");
      const [root, unrelated] = guests;
      assert.ok(root && unrelated);
      await Promise.all([helpers.waitForGuestLoad(root), helpers.waitForGuestLoad(unrelated)]);
      assert.equal(root.session, unrelated.session, "guests use the same profile partition");
      registry.registerWebContents({
        browserId: "root",
        webContentsId: root.id,
        hostWebContentsId: host.webContents.id,
      });
      registry.registerWorkspace({ browserId: "root", workspaceId: "fixture" });
      registry.registerWebContents({
        browserId: "unrelated",
        webContentsId: unrelated.id,
        hostWebContentsId: host.webContents.id,
      });
      registry.registerWorkspace({ browserId: "unrelated", workspaceId: "fixture" });
      const originalCommand = root.debugger.sendCommand.bind(root.debugger);
      root.debugger.sendCommand = (method, params, ...rest) => {
        if (method === "Network.getRequestPostData") requestPostCommands.push(params?.requestId);
        return originalCommand(method, params, ...rest);
      };
      lifecycle.installWindowOpenHandler({
        contents: root,
        sourceContents: root,
        mainWindow: host,
      });
      const caller = { senderId: host.webContents.id, mainFrame: true };
      await root.executeJavaScript(
        `(()=>{window.audioProbe=new AudioContext();const osc=window.audioProbe.createOscillator();const gain=window.audioProbe.createGain();gain.gain.value=0.3;osc.frequency.value=440;osc.connect(gain).connect(window.audioProbe.destination);osc.start();return window.audioProbe.resume()})()`,
        true,
      );
      const recording = await bridge.start(caller, { browserId: "root", audio: true });
      await root.debugger
        .sendCommand("Network.getRequestPostData", { requestId: "probe-invalid" })
        .catch(() => {});
      assert.ok(
        requestPostCommands.includes("probe-invalid"),
        "CDP command instrumentation observes physical sends",
      );
      await unrelated.executeJavaScript("fetch('/api?unrelated=1').then(r=>r.text())");
      await root.executeJavaScript(
        `window.open(${JSON.stringify(`${origin}/popup`)}, '_blank', 'width=320,height=240'); true`,
      );
      await eventually(
        () => popups.length === 1 && lifecycle.coordinator.getMembership(popups[0].webContents.id),
        "production popup joins the recording",
      );
      const popup = popups[0];
      const popupMember = lifecycle.coordinator.getMembership(popup.webContents.id);
      await helpers.waitForGuestLoad(popup.webContents);
      await popup.webContents.executeJavaScript(
        `(()=>{window.audioProbe=new AudioContext();const osc=window.audioProbe.createOscillator();const gain=window.audioProbe.createGain();gain.gain.value=0.3;osc.frequency.value=660;osc.connect(gain).connect(window.audioProbe.destination);osc.start();return window.audioProbe.resume()})()`,
        true,
      );
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some(
            (event) =>
              event.kind === "media" &&
              event.memberId === popupMember.memberId &&
              event.payload.type === "audio-status" &&
              event.payload.status === "captured",
          ),
        "production popup audio is captured",
      );
      await eventually(
        async () =>
          (await store.listMediaSegments(recording.recordingId)).some(
            (segment) => segment.streamId === popupMember.memberId && segment.track === "combined",
          ),
        "production popup has combined audio and video",
      );

      await root.executeJavaScript(
        "fetch('/api?blob-small=1',{method:'POST',body:new Blob(['small blob body'])}).then(r=>r.text())",
      );
      await root.executeJavaScript(
        "fetch('/api?oversized=1',{method:'POST',body:new Blob([new Uint8Array(4*1024*1024)])}).then(r=>r.text())",
      );
      await root.executeJavaScript("fetch('/api?body-failure=1').then(r=>r.text())");
      await eventually(async () => {
        const events = (await store.readEvents(recording.recordingId)).events;
        return ["blob-small=1", "oversized=1", "body-failure=1"].every((suffix) =>
          events.some(
            (event) => event.kind === "network" && event.payload.request?.url?.includes(suffix),
          ),
        );
      }, "small and oversized POSTs and a body failure are recorded");
      const bodyEvents = (await store.readEvents(recording.recordingId)).events;
      const smallBlob = bodyEvents.find(
        (event) => event.kind === "network" && event.payload.request?.url?.includes("blob-small=1"),
      );
      const oversized = bodyEvents.find(
        (event) => event.kind === "network" && event.payload.request?.url?.includes("oversized=1"),
      );
      const bodyFailure = bodyEvents.find(
        (event) =>
          event.kind === "network" && event.payload.request?.url?.includes("body-failure=1"),
      );
      assert.ok(
        ["complete", "unavailable", "truncated"].includes(smallBlob.payload.request.body.state),
        "small Blob is captured or its limitation is explicit",
      );
      if (smallBlob.payload.request.body.state === "complete") {
        const body = smallBlob.payload.request.body;
        assert.equal(
          Buffer.from(body.data, body.encoding).toString("utf8"),
          "small blob body",
          "captured Blob bytes match",
        );
      } else if (smallBlob.payload.request.body.state === "unavailable") {
        assert.ok(smallBlob.payload.request.body.reason, "unavailable Blob includes a reason");
      }
      assert.ok(
        ["truncated", "unavailable"].includes(oversized.payload.request.body.state),
        "oversized body is explicitly limited",
      );
      assert.ok(
        oversizedRequestId && !requestPostCommands.includes(oversizedRequestId),
        "oversized request never dispatches Network.getRequestPostData",
      );
      assert.equal(
        bodyFailure.payload.response.body.state,
        "unavailable",
        "CDP body errors are disclosed",
      );

      await eventually(
        () => interaction.getFrameDocuments(root.id).length > 0,
        "root document identity is registered",
      );
      const oldDocument = interaction.getFrameDocuments(root.id)[0];
      const start = Date.now();
      const startMonotonic = performance.now();
      await root.executeJavaScript(
        `Promise.all(Array.from({length:40},(_,i)=>fetch('/api?burst='+i).then(r=>r.text())))`,
      );
      await root.executeJavaScript(
        `const frame=document.createElement('iframe');frame.src=${JSON.stringify(`http://localhost:${port}/frame`)};document.body.appendChild(frame);true`,
      );
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some(
            (event) => event.kind === "network" && event.payload.request?.url?.includes("burst="),
          ),
        "burst requests reach persistent recording",
      );
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some(
            (event) => event.kind === "network" && event.payload.request?.url?.includes("frame=1"),
          ),
        "cross-origin frame traffic reaches the recording",
      );
      const burstElapsedMs = Date.now() - start;
      root.reload();
      await helpers.waitForGuestLoad(root);
      await eventually(() => {
        const current = lifecycle.coordinator.getFrame({
          webContentsId: root.id,
          frameId: oldDocument.frameId,
        });
        return current && current.documentId !== oldDocument.documentId;
      }, "reloaded document identity is registered");
      const lateClick = await lifecycle.coordinator.emit({
        webContentsId: root.id,
        frameId: oldDocument.frameId,
        documentId: oldDocument.documentId,
        kind: "interaction",
        payload: { type: "late-navigation-click" },
      });
      assert.deepEqual(
        lateClick,
        { ok: false, reason: "stale-document" },
        "late old-document interaction is rejected",
      );
      await root.executeJavaScript("fetch('/api?after-refresh=1').then(r=>r.text())");
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some(
            (event) =>
              event.kind === "network" && event.payload.request?.url?.includes("after-refresh=1"),
          ),
        "capture continues after refresh",
      );
      if (root.debugger.isAttached()) root.debugger.detach();
      await eventually(
        async () =>
          (await store.readEvents(recording.recordingId)).events.some(
            (event) => event.kind === "gap" && event.payload.reason === "debugger-detached",
          ),
        "debugger detach is disclosed",
      );
      const rootMember = lifecycle.coordinator.getMembership(root.id);
      await bridge.stop(caller, { recordingId: recording.recordingId });
      const rootTone = await measureTone(host, store, recording.recordingId, rootMember.memberId);
      const popupTone = await measureTone(host, store, recording.recordingId, popupMember.memberId);
      assert.ok(
        rootTone && rootTone.a > rootTone.b + 5,
        `root captures its own tone: ${JSON.stringify(rootTone)}`,
      );
      assert.ok(
        popupTone && popupTone.b > popupTone.a + 5,
        `popup captures its own tone: ${JSON.stringify(popupTone)}`,
      );
      const events = (await store.readEvents(recording.recordingId)).events;
      const burst = events.filter(
        (event) => event.kind === "network" && event.payload.request?.url?.includes("burst="),
      );
      const gaps = events.filter((event) => event.kind === "gap");
      assert.ok(
        gaps.some((event) => event.payload.reason === "stale-document"),
        "late click creates a persisted stale-document gap",
      );
      assert.ok(
        !events.some(
          (event) => event.kind === "interaction" && event.payload.type === "late-navigation-click",
        ),
        "late click is not attributed to the new document",
      );
      assert.ok(burst.length === 40, `burst lost requests without a gap: ${burst.length}/40`);
      assert.ok(
        !events.some(
          (event) =>
            event.kind === "network" && event.payload.request?.url?.includes("unrelated=1"),
        ),
        "unrelated guest traffic is excluded",
      );
      const frame = events.find(
        (event) => event.kind === "network" && event.payload.request?.url?.includes("frame=1"),
      );
      assert.ok(
        frame && frame.frameAttribution === "identified",
        "cross-origin frame request has verified attribution",
      );
      return [
        {
          group: "recording",
          check: "journey-burst",
          pass: true,
          platform: process.platform,
          burstCount: burst.length,
          elapsedMs: burstElapsedMs,
          gapCount: gaps.length,
          frameAttribution: frame.frameAttribution,
          rootTone,
          popupTone,
          gapReasons: [...new Set(gaps.map((event) => event.payload.reason))],
          clockDriftMs: Date.now() - start - (performance.now() - startMonotonic),
        },
      ];
    } finally {
      await bridge.dispose();
      interaction.dispose();
      await video.dispose();
      for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
      await helpers.closeHarnessWindow(host);
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
};
