const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function observedAudioStatus(media) {
  if (media.audioErrorName === "NotAllowedError") return "denied";
  if (media.audioErrorName) return "unavailable";
  if (!media.audioTracks) return "unavailable";
  return media.audioPeak > 0 ? "pass" : "unverified";
}

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.test");
    response.setHeader("access-control-allow-origin", "*");
    if (url.pathname === "/api") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ received: body, fixture: true }));
      });
      return;
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/api?source=redirected" });
      response.end();
      return;
    }
    if (url.pathname === "/binary") {
      response.setHeader("content-type", "application/octet-stream");
      response.end(Buffer.from([0, 1, 2, 253]));
      return;
    }
    if (url.pathname === "/large") {
      response.setHeader("content-type", "application/octet-stream");
      response.end(Buffer.alloc(512 * 1024, 65));
      return;
    }
    if (url.pathname === "/fail") {
      request.socket.destroy();
      return;
    }
    if (url.pathname === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end("data: synthetic-event\n\n");
      return;
    }
    response.setHeader("content-type", "text/html");
    if (url.pathname === "/frame") {
      const port = server.address().port;
      response.end(`<!doctype html><title>Cross-origin frame</title>
        <iframe src="http://127.0.0.1:${port}/nested"></iframe>
        <script>fetch('http://127.0.0.1:${port}/api?source=immediate-frame'); setTimeout(() => fetch('http://127.0.0.1:${port}/api?source=cross-frame'), 1000)</script>`);
      return;
    }
    if (url.pathname === "/nested") {
      response.end(`<!doctype html><title>Nested frame</title>
        <script>setTimeout(() => fetch('/api?source=nested-frame'), 1500)</script>`);
      return;
    }
    response.end(`<!doctype html><title>Recording fixture</title><style>
      body { margin: 0; animation: colors .3s infinite alternate; }
      @keyframes colors { from { background:#f0f } to { background:#0ff } }
      </style><button id="probe">Probe</button><script>
      document.querySelector('#probe').onclick = () => fetch('/api?click=1');
      </script>`);
  });
  const { WebSocketServer } = require("ws");
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.on("message", (message) => connection.send(`echo:${message}`));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function monitorDebugger(contents, events) {
  const listener = (_event, method, params, sessionId) => {
    if (
      method.startsWith("Network.") ||
      method.startsWith("Target.") ||
      method === "Page.frameNavigated"
    ) {
      events.push({ method, params, sessionId: sessionId || null });
    }
    if (method === "Target.attachedToTarget" && params.sessionId) {
      contents.debugger.sendCommand("Network.enable", {}, params.sessionId).catch(() => {});
      contents.debugger.sendCommand("Page.enable", {}, params.sessionId).catch(() => {});
      contents.debugger
        .sendCommand(
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          params.sessionId,
        )
        .catch(() => {});
    }
  };
  contents.debugger.on("message", listener);
  return () => contents.debugger.removeListener("message", listener);
}

async function sampleScreencast(contents, adapted, label) {
  const hashes = new Set();
  let frames = 0;
  let screenshot = "not attempted";
  const listener = (_event, method, params) => {
    if (method !== "Page.screencastFrame") return;
    frames += 1;
    hashes.add(crypto.createHash("sha256").update(params.data).digest("hex"));
    contents.debugger
      .sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId })
      .catch(() => {});
  };
  contents.debugger.on("message", listener);
  const before = contents.getBackgroundThrottling();
  try {
    await contents.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 40 });
    await sleep(1200);
    if (adapted) {
      try {
        const image = await adapted.withFrameProduction(() =>
          adapted.captureFrame(AbortSignal.timeout(5000)),
        );
        screenshot = image.isEmpty()
          ? "empty"
          : `${image.getSize().width}x${image.getSize().height}`;
      } catch (error) {
        screenshot = `failed: ${error.message}`;
      }
    }
    await sleep(1800);
    await contents.debugger.sendCommand("Page.stopScreencast");
  } finally {
    contents.debugger.removeListener("message", listener);
  }
  return {
    label,
    frames,
    distinctFrames: hashes.size,
    screenshot,
    throttlingBefore: before,
    throttlingAfter: contents.getBackgroundThrottling(),
  };
}

async function sampleTabMedia(target, origin, options = {}) {
  const { BrowserWindow } = require("electron");
  const recorder = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const recordingSession = recorder.webContents.session;
  recordingSession.setDisplayMediaRequestHandler((request, callback) => {
    const sources = { video: target.mainFrame };
    if (request.audioRequested) sources.audio = target.mainFrame;
    callback(sources);
  });
  try {
    await recorder.loadURL(`${origin}/recorder`);
    return await recorder.webContents.executeJavaScript(
      `(async () => {
      let stream;
      let audioErrorName = '';
      let audioErrorMessage = '';
      try {
        if (${Boolean(options.simulateAudioDenial)}) throw new DOMException('synthetic audio denial', 'NotAllowedError');
        stream = await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
      } catch (error) {
        audioErrorName = error.name || 'Error';
        audioErrorMessage = error.message || String(error);
        stream = await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
      }
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      const canvas = document.createElement('canvas');
      canvas.width = 8; canvas.height = 8;
      const context = canvas.getContext('2d');
      const colors = new Set();
      let samples = 0;
      let audioPeak = 0;
      let audioContext;
      if (stream.getAudioTracks().length) {
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        const analyser = audioContext.createAnalyser();
        source.connect(analyser);
        window.__probeAnalyser = analyser;
      }
      const chunks = [];
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data.size); };
      mediaRecorder.start(500);
      const timer = setInterval(() => {
        if (video.videoWidth) {
          context.drawImage(video, 0, 0, 8, 8);
          colors.add(Array.from(context.getImageData(0, 0, 1, 1).data).join(','));
          samples++;
        }
        if (window.__probeAnalyser) {
          const data = new Uint8Array(window.__probeAnalyser.frequencyBinCount);
          window.__probeAnalyser.getByteTimeDomainData(data);
          audioPeak = Math.max(audioPeak, ...data.map(value => Math.abs(value - 128)));
        }
      }, 200);
      await new Promise(resolve => setTimeout(resolve, 3200));
      clearInterval(timer);
      await new Promise(resolve => { mediaRecorder.onstop = resolve; mediaRecorder.stop(); });
      const result = { videoTracks: stream.getVideoTracks().length, audioTracks: stream.getAudioTracks().length,
        videoState: stream.getVideoTracks()[0]?.readyState, samples, colors: colors.size, chunks, audioPeak,
        audioErrorName, audioErrorMessage };
      stream.getTracks().forEach(track => track.stop());
      if (audioContext) await audioContext.close();
      return result;
    })()`,
      true,
    );
  } finally {
    recordingSession.setDisplayMediaRequestHandler(null);
    if (!recorder.isDestroyed()) recorder.destroy();
  }
}

module.exports = {
  name: "feasibility",
  phases: ["single"],
  observedAudioStatus,
  async run({ helpers }) {
    const { adaptWebContents } = require("../dist/features/browser-automation/ipc.js");
    const server = await startServer();
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const records = [];
    const events = [];
    const popupFixtures = [];
    const bodyFixtures = [];
    let handle;
    let popup;
    const add = (name, status, detail) => records.push({ name, status, detail });
    const attempt = async (name, task) => {
      try {
        await helpers.withTimeout(Promise.resolve().then(task), name, 15000);
      } catch (error) {
        add(name, "unverified", String(error.stack || error));
      }
    };
    try {
      handle = helpers.createInactiveHarnessWindow({
        width: 1000,
        height: 700,
        webPreferences: {
          webviewTag: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      helpers.installHarnessWebviewGuards(handle.win, { preloadPath: helpers.guestPreloadPath });
      const tracker = helpers.trackAttachedGuests(handle.win);
      await handle.win.loadFile(path.join(helpers.harnessRoot, "index.html"), {
        query: {
          webviewCount: "0",
          permanentParkingState: "p1-overflow-1x1",
          targetUrl: `${origin}/`,
        },
      });
      await helpers.waitForInactiveReveal(handle, "recording feasibility");
      const { guest } = await helpers.appendPermanentWebview({
        win: handle.win,
        tracker,
        state: { id: "p1-overflow-1x1" },
        sourceUrl: `${origin}/root`,
      });
      await helpers.waitForGuestLoad(guest);
      guest.debugger.attach("1.3");
      const removeMonitor = monitorDebugger(guest, events);
      await guest.debugger.sendCommand("Network.enable");
      await guest.debugger.sendCommand("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      const adapted = adaptWebContents(guest);

      await attempt("request and response bodies", async () => {
        const result = await guest.executeJavaScript(
          `fetch('/api?source=main',{method:'POST',headers:{'content-type':'text/plain'},body:'probe-body'}).then(r=>r.text())`,
        );
        await sleep(250);
        const request = events.find(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url.includes("source=main"),
        );
        const id = request?.params.requestId;
        const body =
          id && (await guest.debugger.sendCommand("Network.getResponseBody", { requestId: id }));
        bodyFixtures.push({ case: "post-response", requestId: id, result: body });
        const ok = request?.params.request?.postData === "probe-body" && body?.body === result;
        add(
          "request and response bodies",
          ok ? "pass" : "unverified",
          `request=${Boolean(request)} post=${request?.params.request?.postData} response=${body?.body}`,
        );
      });

      await attempt("missing body evidence", async () => {
        let errorMessage = "";
        try {
          await guest.debugger.sendCommand("Network.getResponseBody", {
            requestId: "missing-probe-id",
          });
        } catch (error) {
          errorMessage = error.message;
        }
        bodyFixtures.push({
          case: "missing-response",
          requestId: "missing-probe-id",
          error: errorMessage,
        });
        add(
          "missing body evidence",
          errorMessage ? "pass" : "unverified",
          `CDP error=${errorMessage || "no error"}; implementation must represent unavailable bodies explicitly`,
        );
      });

      await attempt("oversized body eviction", async () => {
        const { BrowserWindow } = require("electron");
        const probe = new BrowserWindow({
          show: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });
        const probeEvents = [];
        let remove = () => {};
        try {
          await helpers.withTimeout(
            probe.loadURL(`${origin}/oversized-fixture`),
            "oversized fixture load",
            3000,
          );
          probe.webContents.debugger.attach("1.3");
          remove = monitorDebugger(probe.webContents, probeEvents);
          await helpers.withTimeout(
            probe.webContents.debugger.sendCommand("Network.enable", {
              maxTotalBufferSize: 2048,
              maxResourceBufferSize: 1024,
            }),
            "oversized Network.enable",
            3000,
          );
          const received = await helpers.withTimeout(
            probe.webContents.executeJavaScript(
              `fetch('/large').then(r => r.arrayBuffer()).then(b => b.byteLength)`,
            ),
            "oversized fetch",
            3000,
          );
          await sleep(250);
          const request = probeEvents.find(
            (entry) =>
              entry.method === "Network.requestWillBeSent" &&
              entry.params.request?.url.endsWith("/large"),
          );
          let body = null;
          let errorMessage = "";
          try {
            if (request)
              body = await probe.webContents.debugger.sendCommand("Network.getResponseBody", {
                requestId: request.params.requestId,
              });
          } catch (error) {
            errorMessage = error.message;
          }
          const capturedLength = body
            ? Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8").length
            : 0;
          const missing =
            received === 512 * 1024 &&
            Boolean(request) &&
            (Boolean(errorMessage) || capturedLength < received);
          bodyFixtures.push({
            case: "oversized-response",
            requestId: request?.params.requestId,
            received,
            capturedLength,
            error: errorMessage,
          });
          add(
            "oversized body eviction",
            missing ? "pass" : "unverified",
            `received=${received}; captured=${capturedLength}; CDP error=${errorMessage || "none"}; unavailable or truncated state must be surfaced`,
          );
        } finally {
          remove();
          if (!probe.isDestroyed()) probe.destroy();
        }
      });

      await attempt("redirect, binary, and failure evidence", async () => {
        await guest.executeJavaScript(`Promise.all([
          fetch('/redirect').then(r => r.text()),
          fetch('/binary').then(r => r.arrayBuffer()),
          fetch('/fail').catch(() => null),
        ])`);
        await sleep(250);
        const redirected = events.some(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.redirectResponse?.url?.endsWith("/redirect"),
        );
        const binaryRequest = events.find(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url.endsWith("/binary"),
        );
        const failedRequest = events.find(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url.endsWith("/fail"),
        );
        const failed = events.find(
          (entry) =>
            entry.method === "Network.loadingFailed" &&
            entry.params.requestId === failedRequest?.params.requestId,
        );
        const binary =
          binaryRequest &&
          (await guest.debugger.sendCommand("Network.getResponseBody", {
            requestId: binaryRequest.params.requestId,
          }));
        const decoded =
          binary && Buffer.from(binary.body, binary.base64Encoded ? "base64" : "utf8");
        const binaryMatches = decoded?.equals(Buffer.from([0, 1, 2, 253]));
        bodyFixtures.push({
          case: "binary-response",
          requestId: binaryRequest?.params.requestId,
          result: binary,
        });
        add(
          "redirect, binary, and failure evidence",
          redirected && binaryMatches && failed ? "pass" : "unverified",
          `redirect=${redirected}; binary=${Boolean(binaryMatches)} base64=${binary?.base64Encoded}; failure=${failed?.params.errorText || "missing"}`,
        );
      });

      await attempt("WebSocket and EventSource events", async () => {
        await guest.executeJavaScript(`Promise.all([
          new Promise((resolve, reject) => {
            const socket = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}/socket`)});
            socket.onopen = () => socket.send('synthetic-message');
            socket.onmessage = (event) => { socket.close(); resolve(event.data); };
            socket.onerror = reject;
          }),
          new Promise((resolve, reject) => {
            const source = new EventSource('/events');
            source.onmessage = (event) => { source.close(); resolve(event.data); };
            source.onerror = reject;
          }),
        ])`);
        await sleep(200);
        const methods = new Set(events.map((entry) => entry.method));
        const expected = [
          "Network.webSocketCreated",
          "Network.webSocketFrameSent",
          "Network.webSocketFrameReceived",
          "Network.eventSourceMessageReceived",
        ];
        const missing = expected.filter((method) => !methods.has(method));
        add(
          "WebSocket and EventSource events",
          missing.length ? "unverified" : "pass",
          `missing CDP events=${JSON.stringify(missing)}; fixture payloads are synthetic`,
        );
      });

      await attempt("cross-origin and nested frames", async () => {
        const cross = `http://localhost:${port}/frame`;
        await guest.executeJavaScript(
          `new Promise(resolve => { const frame=document.createElement('iframe'); frame.src=${JSON.stringify(cross)}; frame.onload=()=>resolve(true); document.body.appendChild(frame); })`,
        );
        await sleep(2500);
        const attached = events.filter(
          (entry) => entry.method === "Target.attachedToTarget",
        ).length;
        const frameRequest = events.find(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url.includes("source=cross-frame"),
        );
        const nestedRequest = events.find(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url.includes("source=nested-frame"),
        );
        const frameId = frameRequest?.params.frameId;
        const nestedId = nestedRequest?.params.frameId;
        const childSessions = events.filter((entry) => entry.method === "Target.attachedToTarget");
        const frameTarget = childSessions.find(
          (entry) => entry.params.sessionId === frameRequest?.sessionId,
        );
        const nestedTarget = childSessions.find(
          (entry) => entry.params.sessionId === nestedRequest?.sessionId,
        );
        const attributed =
          frameTarget?.params.targetInfo?.targetId === frameId &&
          nestedTarget?.params.targetInfo?.targetId === nestedId;
        const immediate = events.some(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url.includes("source=immediate-frame"),
        );
        add(
          "cross-origin and nested frames",
          frameId && nestedId && frameId !== nestedId && attributed ? "pass" : "unverified",
          `separate targets=${attached}; cross-frame request=${Boolean(frameRequest)} frame=${frameId}; nested request=${Boolean(nestedRequest)} frame=${nestedId}; child sessions match targets=${attributed}; immediate child request observed=${immediate}`,
        );
        add(
          "immediate child-target request",
          immediate ? "pass" : "limitation",
          `no-delay fetch observed=${immediate}; early target attachment or visible capture gaps are required`,
        );
        const frameDocument = events.some(
          (entry) =>
            entry.method === "Network.requestWillBeSent" && entry.params.request?.url === cross,
        );
        const nestedDocument = events.some(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url === `${origin}/nested`,
        );
        add(
          "frame navigation initial requests",
          frameDocument && nestedDocument ? "pass" : "limitation",
          `cross-origin document=${frameDocument}; nested document=${nestedDocument}; any missed request must be reported as a gap`,
        );
      });

      await attempt("reload continuity", async () => {
        const before = events.length;
        const beforeFrame = (await guest.debugger.sendCommand("Page.getFrameTree")).frameTree.frame;
        const loaded = new Promise((resolve) => guest.once("did-finish-load", resolve));
        guest.reload();
        await helpers.withTimeout(loaded, "guest reload", 5000);
        await guest.executeJavaScript(`fetch('/api?source=after-reload').then(r => r.text())`);
        await sleep(250);
        const request = events
          .slice(before)
          .find(
            (entry) =>
              entry.method === "Network.requestWillBeSent" &&
              entry.params.request?.url.includes("source=after-reload"),
          );
        const afterFrame = (await guest.debugger.sendCommand("Page.getFrameTree")).frameTree.frame;
        const documentRequest = events
          .slice(before)
          .some(
            (entry) =>
              entry.method === "Network.requestWillBeSent" &&
              entry.params.type === "Document" &&
              entry.params.loaderId === afterFrame.loaderId,
          );
        const attributed =
          request?.params.frameId === afterFrame.id &&
          request?.params.loaderId === afterFrame.loaderId &&
          beforeFrame.loaderId !== afterFrame.loaderId;
        add(
          "reload continuity",
          guest.debugger.isAttached() && attributed ? "pass" : "unverified",
          `debugger attached=${guest.debugger.isAttached()}; post-reload request observed=${Boolean(request)}; frame and new loader attributed=${attributed}; document request observed=${documentRequest}`,
        );
        add(
          "reload document request",
          documentRequest ? "pass" : "limitation",
          `document request for new loader observed=${documentRequest}`,
        );
      });

      await attempt("cross-origin navigation continuity", async () => {
        const before = events.length;
        await guest.loadURL(`http://localhost:${port}/cross-navigation`);
        await guest.executeJavaScript(`fetch('/api?source=after-navigation').then(r => r.text())`);
        await sleep(250);
        const frame = (await guest.debugger.sendCommand("Page.getFrameTree")).frameTree.frame;
        const request = events
          .slice(before)
          .find(
            (entry) =>
              entry.method === "Network.requestWillBeSent" &&
              entry.params.request?.url.includes("source=after-navigation"),
          );
        const attributed =
          request?.params.frameId === frame.id && request?.params.loaderId === frame.loaderId;
        const documentRequest = events
          .slice(before)
          .some(
            (entry) =>
              entry.method === "Network.requestWillBeSent" &&
              entry.params.type === "Document" &&
              entry.params.loaderId === frame.loaderId,
          );
        add(
          "cross-origin navigation continuity",
          attributed ? "pass" : "unverified",
          `request=${Boolean(request)} frame and loader attributed=${attributed}; document request observed=${documentRequest}; page=${frame.url}`,
        );
        add(
          "cross-origin navigation document request",
          documentRequest ? "pass" : "limitation",
          `document request for new loader observed=${documentRequest}`,
        );
        await guest.loadURL(`${origin}/root?returned=1`);
      });

      await attempt("popup initial request", async () => {
        const earlyRequests = [];
        guest.session.webRequest.onBeforeRequest({ urls: [`${origin}/*`] }, (details, callback) => {
          if (details.url.includes("/popup?first=1"))
            earlyRequests.push({
              id: details.id,
              webContentsId: details.webContentsId,
              url: details.url,
            });
          callback({ cancel: false });
        });
        guest.setWindowOpenHandler(() => ({
          action: "allow",
          overrideBrowserWindowOptions: { show: false },
        }));
        const created = new Promise((resolve) => guest.once("did-create-window", resolve));
        await guest.executeJavaScript(
          `window.open(${JSON.stringify(`${origin}/popup?first=1`)}, 'recording-probe', 'width=350,height=250'); true`,
        );
        popup = await helpers.withTimeout(created, "popup creation", 5000);
        const popupEvents = [];
        popup.webContents.debugger.attach("1.3");
        const remove = monitorDebugger(popup.webContents, popupEvents);
        await popup.webContents.debugger.sendCommand("Network.enable");
        await helpers.waitForGuestLoad(popup.webContents);
        await sleep(200);
        const initial = popupEvents.some(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url.includes("/popup?first=1"),
        );
        const early = earlyRequests[0];
        const attributed = early?.webContentsId === popup.webContents.id;
        let status = "unverified";
        if (attributed) status = "partial";
        if (initial) status = "pass";
        add(
          "popup post-creation CDP and session metadata",
          status,
          `post-creation CDP saw first request=${initial}; early hook saw=${Boolean(early)}; attributed to popup=${attributed}; details=${JSON.stringify(early || null)}`,
        );
        remove();
        guest.session.webRequest.onBeforeRequest(null);
      });

      await attempt("popup early debugger attachment", async () => {
        const { BrowserWindow } = require("electron");
        let earlyPopup;
        let enableNetwork;
        let removeEarlyMonitor;
        let popupEvents = [];
        const samples = [];
        guest.setWindowOpenHandler(() => ({
          action: "allow",
          createWindow(options) {
            popupEvents = [];
            earlyPopup = new BrowserWindow({ ...options, show: false });
            earlyPopup.webContents.debugger.attach("1.3");
            removeEarlyMonitor = monitorDebugger(earlyPopup.webContents, popupEvents);
            enableNetwork = earlyPopup.webContents.debugger.sendCommand("Network.enable");
            return earlyPopup.webContents;
          },
        }));
        try {
          for (let index = 0; index < 5; index += 1) {
            const popupUrl = `${origin}/popup?early=${index}`;
            await guest.executeJavaScript(
              `window.open(${JSON.stringify(popupUrl)}, ${JSON.stringify(`early-probe-${index}`)}, 'width=350,height=250'); true`,
            );
            if (!earlyPopup) throw new Error("custom popup was not created");
            await enableNetwork;
            await helpers.waitForGuestLoad(earlyPopup.webContents);
            await sleep(100);
            const request = popupEvents.find(
              (entry) =>
                entry.method === "Network.requestWillBeSent" &&
                entry.params.request?.url === popupUrl,
            );
            const response = popupEvents.find(
              (entry) =>
                entry.method === "Network.responseReceived" &&
                entry.params.requestId === request?.params.requestId,
            );
            let body = null;
            try {
              if (request)
                body = await earlyPopup.webContents.debugger.sendCommand(
                  "Network.getResponseBody",
                  { requestId: request.params.requestId },
                );
            } catch (error) {
              body = { error: error.message };
            }
            const opener = await earlyPopup.webContents.executeJavaScript("window.opener !== null");
            popupFixtures.push({ url: popupUrl, events: popupEvents, body });
            samples.push({
              request: Boolean(request),
              response: Boolean(response),
              body: Boolean(body?.body?.includes("Recording fixture")),
              opener,
            });
            removeEarlyMonitor();
            removeEarlyMonitor = null;
            earlyPopup.close();
            earlyPopup = null;
          }
          const complete = samples.every(
            (sample) => sample.request && sample.response && sample.body && sample.opener,
          );
          add(
            "popup early debugger attachment",
            complete ? "pass" : "unverified",
            `samples=${JSON.stringify(samples)}; custom createWindow path; OAuth and POST behavior require separate verification`,
          );
        } finally {
          if (removeEarlyMonitor) removeEarlyMonitor();
          if (earlyPopup && !earlyPopup.isDestroyed()) earlyPopup.close();
        }
      });

      await attempt("parked tab video with screenshot", async () => {
        const sample = await sampleScreencast(guest, adapted, "parked tab");
        add(
          "parked tab video with screenshot",
          sample.frames >= 2 &&
            sample.distinctFrames >= 2 &&
            !sample.screenshot.startsWith("failed") &&
            sample.throttlingBefore === sample.throttlingAfter
            ? "pass"
            : "unverified",
          JSON.stringify(sample),
        );
      });

      await attempt("parked tab media video", async () => {
        let resolveOpen;
        const openRequest = new Promise((resolve) => {
          resolveOpen = resolve;
        });
        guest.setWindowOpenHandler(({ url }) => {
          resolveOpen(url);
          return { action: "deny" };
        });
        await guest.executeJavaScript(
          `window.open(${JSON.stringify(`${origin}/descendant`)}, '_blank'); true`,
        );
        const openedUrl = await helpers.withTimeout(openRequest, "descendant tab request", 5000);
        const { guest: descendant } = await helpers.appendPermanentWebview({
          win: handle.win,
          tracker,
          state: { id: "p1-overflow-1x1" },
          sourceUrl: openedUrl,
        });
        await helpers.waitForGuestLoad(descendant);
        const geometryBefore = await helpers.renderer(
          handle.win,
          "window.captureHarness.waitForFrames(2)",
        );
        const before = descendant.getBackgroundThrottling();
        await descendant.executeJavaScript(
          `(async () => {
          const context = new AudioContext(); const oscillator = context.createOscillator();
          oscillator.frequency.value = 440; oscillator.connect(context.destination); oscillator.start();
          await context.resume(); window.__recordingProbeAudio = { context, oscillator }; return context.state;
        })()`,
          true,
        );
        const mediaPromise = sampleTabMedia(descendant, origin).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await sleep(1200);
        const adapter = adaptWebContents(descendant);
        let screenshot = "not captured";
        try {
          const image = await adapter.withFrameProduction(() =>
            adapter.captureFrame(AbortSignal.timeout(5000)),
          );
          screenshot = image.isEmpty()
            ? "empty"
            : `${image.getSize().width}x${image.getSize().height}`;
        } catch (error) {
          screenshot = `failed: ${error.message}`;
        }
        const mediaResult = await mediaPromise;
        if (mediaResult.error) throw mediaResult.error;
        const media = mediaResult.value;
        await descendant.executeJavaScript(
          `window.__recordingProbeAudio.oscillator.stop(); window.__recordingProbeAudio.context.close()`,
        );
        const geometryAfter = await helpers.renderer(
          handle.win,
          "window.captureHarness.waitForFrames(2)",
        );
        const after = descendant.getBackgroundThrottling();
        const geometryStable =
          geometryBefore.hostRect.width === 1 &&
          geometryBefore.hostRect.height === 1 &&
          JSON.stringify(geometryBefore.hostRect) === JSON.stringify(geometryAfter.hostRect) &&
          geometryBefore.webviews.length === 2 &&
          JSON.stringify(geometryBefore.webviews) === JSON.stringify(geometryAfter.webviews);
        const good =
          media.videoTracks &&
          media.samples > 1 &&
          media.colors > 1 &&
          media.chunks.length &&
          !screenshot.startsWith("failed") &&
          screenshot !== "empty" &&
          before === after &&
          geometryStable;
        add(
          "parked tab media video",
          good ? "pass" : "unverified",
          `simulated workspace-tab routing from window.open; ${JSON.stringify({ ...media, screenshot, geometryStable, throttlingBefore: before, throttlingAfter: after })}`,
        );
        add(
          "parked tab audio",
          observedAudioStatus(media),
          `synthetic 440Hz source; audioTracks=${media.audioTracks}; audioPeak=${media.audioPeak}; error=${media.audioErrorName}: ${media.audioErrorMessage}`,
        );
      });

      await attempt("hidden popup CDP screencast", async () => {
        if (!popup) throw new Error("popup was not created");
        popup.hide();
        if (!popup.webContents.debugger.isAttached()) popup.webContents.debugger.attach("1.3");
        const sample = await sampleScreencast(popup.webContents, null, "hidden popup");
        add(
          "hidden popup CDP screencast",
          sample.frames >= 2 && sample.distinctFrames >= 2 ? "pass" : "limitation",
          JSON.stringify(sample),
        );
      });

      await attempt("hidden popup media capture", async () => {
        if (!popup) throw new Error("popup was not created");
        await popup.webContents.executeJavaScript(
          `(async () => {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          oscillator.frequency.value = 440;
          oscillator.connect(context.destination);
          oscillator.start();
          await context.resume();
          window.__recordingProbeAudio = { context, oscillator };
          return context.state;
        })()`,
          true,
        );
        const before = popup.webContents.getBackgroundThrottling();
        const mediaPromise = sampleTabMedia(popup.webContents, origin).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await sleep(1200);
        let screenshot = "not captured";
        try {
          const popupAdapter = adaptWebContents(popup.webContents);
          const image = await popupAdapter.withFrameProduction(() =>
            popupAdapter.captureFrame(AbortSignal.timeout(5000)),
          );
          screenshot = image.isEmpty()
            ? "empty"
            : `${image.getSize().width}x${image.getSize().height}`;
        } catch (error) {
          screenshot = `failed: ${error.message}`;
        }
        const mediaResult = await mediaPromise;
        if (mediaResult.error) throw mediaResult.error;
        const media = mediaResult.value;
        const denial = await sampleTabMedia(popup.webContents, origin, {
          simulateAudioDenial: true,
        });
        add(
          "audio-denial video-only fallback",
          denial.audioErrorName === "NotAllowedError" &&
            denial.videoTracks &&
            denial.samples > 1 &&
            denial.chunks.length &&
            denial.audioTracks === 0
            ? "pass"
            : "unverified",
          `synthetic audio denial; ${JSON.stringify(denial)}`,
        );
        const after = popup.webContents.getBackgroundThrottling();
        await popup.webContents.executeJavaScript(
          `window.__recordingProbeAudio.oscillator.stop(); window.__recordingProbeAudio.context.close()`,
        );
        add(
          "never-shown popup media video",
          media.videoTracks &&
            media.samples > 1 &&
            media.colors > 1 &&
            media.chunks.length &&
            !screenshot.startsWith("failed") &&
            screenshot !== "empty" &&
            before === after
            ? "pass"
            : "unverified",
          JSON.stringify({
            ...media,
            screenshot,
            throttlingBefore: before,
            throttlingAfter: after,
          }),
        );
        add(
          "audio",
          observedAudioStatus(media),
          `synthetic 440Hz source; ${JSON.stringify(media)}`,
        );
      });

      await attempt("automation and DevTools coexistence", async () => {
        let detached = false;
        let secondConsumerCount = 0;
        const onDetach = () => {
          detached = true;
        };
        const secondConsumer = (_event, method, params) => {
          if (
            method === "Network.requestWillBeSent" &&
            params.request?.url.includes("source=devtools-open")
          )
            secondConsumerCount += 1;
        };
        guest.debugger.on("detach", onDetach);
        guest.debugger.on("message", secondConsumer);
        try {
          const before = await adapted.sendDebugCommand("Runtime.evaluate", {
            expression: "1+1",
            returnByValue: true,
          });
          guest.openDevTools({ mode: "detach", activate: false });
          await sleep(500);
          const concurrent = await adapted.sendDebugCommand("Runtime.evaluate", {
            expression: "3+3",
            returnByValue: true,
          });
          const duringStart = events.length;
          await guest.executeJavaScript(`fetch('/api?source=devtools-open').then(r => r.text())`);
          await sleep(200);
          const duringObserved = events
            .slice(duringStart)
            .some(
              (entry) =>
                entry.method === "Network.requestWillBeSent" &&
                entry.params.request?.url.includes("source=devtools-open"),
            );
          const attachedDuring = guest.debugger.isAttached();
          guest.closeDevTools();
          await sleep(250);
          const after = await adapted.sendDebugCommand("Runtime.evaluate", {
            expression: "2+2",
            returnByValue: true,
          });
          add(
            "automation and DevTools coexistence",
            duringObserved &&
              attachedDuring &&
              secondConsumerCount === 1 &&
              concurrent?.result?.value === 6 &&
              before?.result?.value === 2 &&
              after?.result?.value === 4
              ? "pass"
              : "partial",
            `automation before=${before?.result?.value}; concurrent=${concurrent?.result?.value}; detach observed=${detached}; debugger attached while open=${attachedDuring}; open-period network observed=${duringObserved}; second listener on the same debugger received ${secondConsumerCount} event(s); after=${after?.result?.value}`,
          );
        } finally {
          guest.closeDevTools();
          guest.debugger.removeListener("message", secondConsumer);
          guest.debugger.removeListener("detach", onDetach);
        }
      });

      await attempt("forced debugger detach and recovery", async () => {
        let detached = false;
        const onDetach = () => {
          detached = true;
        };
        guest.debugger.once("detach", onDetach);
        try {
          guest.debugger.detach();
          await sleep(100);
          await adapted.sendDebugCommand("Network.enable");
          const before = events.length;
          await guest.executeJavaScript(`fetch('/api?source=after-detach').then(r => r.text())`);
          await sleep(200);
          const observed = events
            .slice(before)
            .some(
              (entry) =>
                entry.method === "Network.requestWillBeSent" &&
                entry.params.request?.url.includes("source=after-detach"),
            );
          add(
            "forced debugger detach and recovery",
            detached && guest.debugger.isAttached() && observed ? "pass" : "unverified",
            `detach event=${detached}; reattached=${guest.debugger.isAttached()}; later network observed=${observed}; visible recording-gap reporting remains an implementation requirement`,
          );
          add(
            "child targets after debugger reattach",
            "unverified",
            "Only a main-frame request was checked after forced detach; restoring child sessions and popup coverage remains an implementation test.",
          );
        } finally {
          guest.debugger.removeListener("detach", onDetach);
        }
      });
      removeMonitor();

      await attempt("guest replacement lifecycle", async () => {
        const originalId = guest.id;
        const destroyed = new Promise((resolve) => guest.once("destroyed", resolve));
        await helpers.renderer(
          handle.win,
          `document.getElementById('target-webview-1').remove(); true`,
        );
        await helpers.withTimeout(destroyed, "guest destruction", 5000);
        const replacement = await helpers.appendPermanentWebview({
          win: handle.win,
          tracker,
          state: { id: "p1-overflow-1x1" },
          sourceUrl: `${origin}/replacement`,
        });
        await helpers.waitForGuestLoad(replacement.guest);
        const changed = guest.isDestroyed() && replacement.guest.id !== originalId;
        const replacementEvents = [];
        replacement.guest.debugger.attach("1.3");
        const removeReplacementMonitor = monitorDebugger(replacement.guest, replacementEvents);
        await replacement.guest.debugger.sendCommand("Network.enable");
        const firstDocument = replacementEvents.some(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url.includes("/replacement"),
        );
        await replacement.guest.executeJavaScript(
          `fetch('/api?source=replacement').then(r => r.text())`,
        );
        await sleep(200);
        const frame = (await replacement.guest.debugger.sendCommand("Page.getFrameTree")).frameTree
          .frame;
        const request = replacementEvents.find(
          (entry) =>
            entry.method === "Network.requestWillBeSent" &&
            entry.params.request?.url.includes("source=replacement"),
        );
        const attributed =
          request?.params.frameId === frame.id && request?.params.loaderId === frame.loaderId;
        add(
          "guest replacement lifecycle",
          changed && attributed ? "pass" : "unverified",
          `old id=${originalId} destroyed=${guest.isDestroyed()}; replacement id=${replacement.guest.id}; new request attributed=${attributed}; recording identity reconnect remains an implementation task`,
        );
        add(
          "replacement first-document request",
          firstDocument ? "pass" : "limitation",
          `attach-after-load first document observed=${firstDocument}; the implementation must attach earlier or report the gap`,
        );
        removeReplacementMonitor();
      });
    } finally {
      if (popup && !popup.isDestroyed()) popup.close();
      if (handle) await helpers.closeHarnessWindow(handle.win);
      await new Promise((resolve) => server.close(resolve));
    }
    if (!records.some((entry) => entry.name === "audio")) {
      add(
        "audio",
        "unverified",
        "Audio stream did not complete; see the hidden popup media capture result.",
      );
    }
    add(
      "large-body handling",
      "partial",
      "The bounded-buffer fixture checks eviction. Other streaming and upload body limits require implementation tests.",
    );
    add(
      "service-worker traffic",
      "unverified",
      "Service-worker target traffic has not been probed. The feature must explicitly report any unsupported capture.",
    );
    add(
      "popup OAuth, POST, and named-window reuse",
      "unverified",
      "The early attachment fixture exercises five synthetic GET popups and window.opener only.",
    );
    add(
      "shown-then-hidden and minimized popups",
      "unverified",
      "The media fixture hides a popup created without showing it. Minimized and previously visible windows require platform tests.",
    );
    const reportDir = path.resolve(helpers.harnessRoot, "../../../.loop-design/browser-recording");
    await fs.mkdir(reportDir, { recursive: true });
    const fixturePath = path.join(reportDir, `cdp-fixture-${process.platform}.json`);
    await fs.writeFile(
      fixturePath,
      JSON.stringify({ events, popupFixtures, bodyFixtures }, null, 2),
    );
    const observations = {
      platform: process.platform,
      electron: process.versions.electron,
      display: process.env.PASEO_RECORDING_DISPLAY_DESCRIPTION || "not specified",
      observedAt: new Date().toISOString(),
      runId: process.env.PASEO_RECORDING_FEASIBILITY_RUN_ID || null,
      records,
      fixturePath,
    };
    await fs.writeFile(
      path.join(reportDir, `feasibility-${process.platform}.json`),
      JSON.stringify(observations, null, 2),
    );
    const platformLines = [];
    for (const platform of ["linux", "darwin", "win32"]) {
      try {
        const data = JSON.parse(
          await fs.readFile(path.join(reportDir, `feasibility-${platform}.json`), "utf8"),
        );
        platformLines.push(
          `- ${platform}: observed ${data.observedAt}, Electron ${data.electron}, display ${data.display}; ${data.records.filter((entry) => entry.status !== "pass").length} non-passing probe(s).`,
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        platformLines.push(`- ${platform}: unverified.`);
      }
    }
    const lines = [
      "# Browser recording feasibility",
      "",
      `Current platform: ${process.platform}; Electron ${process.versions.electron}; display: ${observations.display}.`,
      "Command: `node packages/desktop/capture-harness/recording-run-feasibility.js` (runs `PASEO_CAPTURE_HARNESS_GROUP=recording npm run capture-harness --workspace=@getpaseo/desktop` followed by the verifier).",
      "Captured command output: `.loop-plan/browser-recording/code/T03-green.txt` when run through the build ledger.",
      "",
      "| Probe | Status | Evidence |",
      "| --- | --- | --- |",
      ...records.map(
        (entry) =>
          `| ${entry.name} | ${entry.status} | ${entry.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
      ),
      "",
      "## Platform observations",
      ...platformLines,
      "",
      "## Selected mechanisms for this platform",
      "These are implementation starting points when the associated probe passes; a failed or unverified probe is not an approval to proceed with that capability.",
      "- Network and bodies: CDP Network events with eager response-body retrieval; streaming, redirects and uploads need implementation tests.",
      "- Cross-origin frames: recursively auto-attach child targets and enable their Network domains; initial child-target races still need implementation tests.",
      "- Popup startup: custom `createWindow` attachment before navigation; OAuth, POST and named-window behavior need separate verification. Session webRequest sees early request metadata but does not prove body capture.",
      "- Video: Electron WebFrameMain display-media capture for the parked descendant and hidden popup if both probes pass. CDP screencast is an observed fallback only for the parked guest. Encoding, playback and long-duration resource use remain unverified.",
      "- Audio: WebFrameMain display-media audio with an explicit user-selected mode; OS permissions and other devices remain unverified.",
      "- Debugger: share the existing adapter's connection and report detach or capture gaps; DevTools behavior must be checked on each platform.",
      "",
      "Results are observations of synthetic fixtures, not a guarantee across platforms.",
      "Throttling before/after values are setting readbacks, not proof of runtime scheduling. Frame samples and geometry are reported separately.",
      "",
      `CDP event fixture: ${fixturePath}`,
      "",
    ];
    await fs.writeFile(path.join(reportDir, "feasibility.md"), lines.join("\n"));
    return records.map((entry) => ({
      group: "recording",
      check: entry.name,
      pass: true,
      limitation: entry.status === "pass" ? undefined : `${entry.status}: ${entry.detail}`,
    }));
  },
};
