const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  assert.fail(message);
}

module.exports = {
  name: "video-capture",
  phases: ["single"],
  async run({ helpers }) {
    const modulePath = path.join(__dirname, "../dist/features/browser-recording/video-capture.js");
    assert.ok(fs.existsSync(modulePath), "production video capture module must exist");
    const {
      PaseoBrowserWebviewRegistry,
    } = require("../dist/features/browser-webviews/registry.js");
    const {
      createBrowserRecordingLifecycle,
    } = require("../dist/features/browser-recording/lifecycle.js");
    const { BrowserRecordingStore } = require("../dist/features/browser-recording/store.js");
    const { createVideoCaptureManager } = require(modulePath);
    const server = http.createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><body style='background:blue'>popup</body>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-video-test-"));
    const store = new BrowserRecordingStore(directory);
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
    helpers.installHarnessWebviewGuards(host, { preloadPath: helpers.guestPreloadPath });
    const tracker = helpers.trackAttachedGuests(host);
    await host.loadFile(path.join(helpers.harnessRoot, "index.html"), {
      query: {
        webviewCount: "0",
        permanentParkingState: "p1-overflow-1x1",
        targetUrl: `http://127.0.0.1:${server.address().port}/`,
      },
    });
    await helpers.waitForInactiveReveal(handle, "video parked guest");
    const { guest } = await helpers.appendPermanentWebview({
      win: host,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: `http://127.0.0.1:${server.address().port}/`,
    });
    await helpers.waitForGuestLoad(guest);
    const root = {
      webContents: guest,
      loadURL: (url) => guest.loadURL(url),
      reload: () => guest.reload(),
      isDestroyed: () => guest.isDestroyed(),
      destroy: () => {},
    };
    const replacementHandle = helpers.createInactiveHarnessWindow({ width: 320, height: 240 });
    const replacement = replacementHandle.win;
    const popups = [];
    const errors = [];
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      browserId: "root",
      webContentsId: root.webContents.id,
      hostWebContentsId: host.webContents.id,
    });
    registry.registerWorkspace({ browserId: "root", workspaceId: "fixture" });
    const lifecycle = createBrowserRecordingLifecycle({
      registry,
      onTabOpen: () => {},
      onPopup: (popup) => popups.push(popup),
      onError: (error) => errors.push(error),
    });
    const manager = createVideoCaptureManager({
      coordinator: lifecycle.coordinator,
      store,
      onError: (error) => errors.push(error),
    });
    try {
      await store.create({
        recordingId: "video",
        workspaceId: "fixture",
        startedAt: Date.now(),
        status: "recording",
      });
      const member = lifecycle.coordinator.start({
        recordingId: "video",
        hostWebContentsId: host.webContents.id,
        browserId: "root",
        sink: { write: (event) => store.appendEvent("video", event) },
      });
      lifecycle.installWindowOpenHandler({
        contents: root.webContents,
        sourceContents: root.webContents,
        mainWindow: host,
      });
      await root.loadURL("data:text/html,<body style='background:red'>root</body>");
      await manager.start("video");
      await eventually(
        async () =>
          (await store.listMediaSegments("video")).some((s) => s.streamId === member.memberId),
        "root video is persisted",
      );
      const initialGenerations = new Set(
        (await store.listMediaSegments("video"))
          .filter((s) => s.streamId === member.memberId)
          .map((s) => s.generationId),
      );
      await sleep(11000);
      assert.equal(errors.length, 0, "idle parked guest remains recording past watchdog interval");
      assert.equal(
        new Set(
          (await store.listMediaSegments("video"))
            .filter((s) => s.streamId === member.memberId)
            .map((s) => s.generationId),
        ).size,
        initialGenerations.size,
        "idle updates do not restart the recorder",
      );
      await root.webContents.executeJavaScript(
        "document.head.insertAdjacentHTML('beforeend', '<style>body { animation: recording-colors .3s infinite alternate } @keyframes recording-colors { from { background: red } to { background: #e00000 } }</style>')",
      );
      await helpers.renderer(host, "window.captureHarness.waitForFrames(2)");
      const { adaptWebContents } = require("../dist/features/browser-automation/ipc.js");
      const screenshotTarget = adaptWebContents(root.webContents);
      const screenshot = await helpers.withTimeout(
        screenshotTarget.withFrameProduction(async () => {
          await helpers.withTimeout(
            screenshotTarget.executeJavaScript(
              "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
            ),
            "parked guest paint",
            3000,
          );
          screenshotTarget.invalidate();
          return screenshotTarget.captureFrame(AbortSignal.timeout(5000));
        }),
        "screenshot during video capture",
        5000,
      );
      assert.ok(screenshot.getSize().width > 0, "screenshots coexist with video recording");
      await root.webContents.executeJavaScript(
        `window.open('http://127.0.0.1:${server.address().port}/', '_blank', 'width=320,height=240'); true`,
      );
      await eventually(() => popups.length === 1, "popup is opened");
      const popupMember = lifecycle.coordinator.getMembership(popups[0].webContents.id);
      assert.ok(popupMember, "popup belongs to recording");
      await eventually(
        async () =>
          (await store.listMediaSegments("video")).some((s) => s.streamId === popupMember.memberId),
        "popup video is persisted separately",
      );
      await root.reload();
      await eventually(
        async () =>
          new Set(
            (await store.listMediaSegments("video"))
              .filter((s) => s.streamId === member.memberId)
              .map((s) => s.generationId),
          ).size >= 2,
        "root capture restarts after reload",
      );
      await replacement.loadURL("data:text/html,<body style='background:green'>replacement</body>");
      registry.registerWebContents({
        browserId: "root",
        webContentsId: replacement.webContents.id,
        hostWebContentsId: host.webContents.id,
      });
      const updated = lifecycle.coordinator.replaceBrowserGuest({
        hostWebContentsId: host.webContents.id,
        browserId: "root",
      });
      assert.equal(updated.memberId, member.memberId, "replacement retains stream identity");
      await eventually(
        async () =>
          new Set(
            (await store.listMediaSegments("video"))
              .filter((s) => s.streamId === member.memberId)
              .map((s) => s.generationId),
          ).size >= 3,
        "replacement capture starts a third generation",
      );
      await lifecycle.coordinator.stop("video");
      const segments = await store.listMediaSegments("video");
      const metadata = await store.readMetadata("video");
      const wallElapsed = Date.now() - metadata.startedAt;
      assert.ok(
        segments.every((segment) => segment.startMs + segment.durationMs <= wallElapsed + 2000),
        "video times use the recording timeline",
      );
      assert.ok(
        segments.filter((s) => s.streamId === member.memberId).length >= 2,
        "root video survives reload",
      );
      const recordedEvents = await store.readEvents("video");
      assert.ok(
        recordedEvents.events.some(
          (event) => event.kind === "gap" && event.payload.reason === "video-navigation-gap",
        ),
        "navigation interval is marked as a gap",
      );
      assert.ok(
        recordedEvents.events.some(
          (event) => event.kind === "gap" && event.payload.reason === "video-guest-replaced",
        ),
        "replacement interval is marked as a gap",
      );
      assert.ok(
        segments.every((s) => s.track === "video" && s.durationMs >= 0 && s.startMs >= 0),
        "video segments carry synchronized timing and no audio",
      );
      assert.ok(
        new Set(segments.filter((s) => s.streamId === member.memberId).map((s) => s.generationId))
          .size >= 2,
        "reload starts a new video generation",
      );
      for (const streamId of [member.memberId, popupMember.memberId]) {
        const pieces = segments.filter((segment) => segment.streamId === streamId);
        const generations = [...new Set(pieces.map((piece) => piece.generationId))];
        assert.ok(
          pieces.every((piece, index) => !index || piece.startMs >= pieces[index - 1].startMs),
          "generations share a monotonic timeline",
        );
        assert.ok(generations.every(Boolean), "video generations have identities");
        for (let index = 0; index < generations.length; index++) {
          const ordered = pieces
            .filter((piece) => piece.generationId === generations[index])
            .sort((a, b) => a.sequence - b.sequence);
          assert.deepEqual(
            ordered.map((piece) => piece.sequence),
            ordered.map((_, i) => i),
          );
          assert.ok(
            ordered.every((piece, i) => !i || piece.startMs >= ordered[i - 1].startMs),
            "segment timestamps are ordered",
          );
          const buffers = [];
          for (const piece of ordered)
            buffers.push(
              Buffer.from((await store.readMediaSegment("video", streamId, piece.segmentId)).bytes),
            );
          const encoded = Buffer.concat(buffers).toString("base64");
          const pixel = await host.webContents.executeJavaScript(`new Promise((resolve) => {
            const video = document.createElement('video');
            setTimeout(() => resolve(null), 5000);
            video.preload = 'auto';
            video.onloadeddata = () => {
              const canvas = document.createElement('canvas');
              canvas.width = video.videoWidth; canvas.height = video.videoHeight;
              const context = canvas.getContext('2d');
              context.drawImage(video, 0, 0);
              resolve([...context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data]);
            };
            video.onerror = () => resolve(null);
            video.src = 'data:video/webm;base64,${encoded}';
          })`);
          assert.ok(pixel, "each saved generation decodes in Electron");
          let channel = index < 2 ? 0 : 1;
          if (streamId === popupMember.memberId) channel = 2;
          assert.ok(
            pixel[channel] > pixel[(channel + 1) % 3] + 30 &&
              pixel[channel] > pixel[(channel + 2) % 3] + 30,
            `video frame matches source ${streamId === member.memberId ? "root" : "popup"} generation ${index}: ${pixel}`,
          );
        }
      }
      assert.deepEqual(errors, [], "capture succeeds without hidden errors");
      await store.create({
        recordingId: "failure",
        workspaceId: "fixture",
        startedAt: Date.now(),
        status: "recording",
      });
      lifecycle.coordinator.start({
        recordingId: "failure",
        hostWebContentsId: host.webContents.id,
        browserId: "root",
        sink: { write: (event) => store.appendEvent("failure", event) },
      });
      const failures = [];
      const failingManager = createVideoCaptureManager({
        coordinator: lifecycle.coordinator,
        store: {
          readMetadata: (id) => store.readMetadata(id),
          writeMediaSegment: async () => {
            throw new Error("synthetic disk failure");
          },
        },
        onError: (error) => failures.push(error),
      });
      try {
        await failingManager.start("failure");
        await eventually(
          () => failures.length > 0,
          "storage failure reaches caller without waiting for stop",
        );
        await assert.rejects(lifecycle.coordinator.stop("failure"), /Video capture failed/);
        assert.ok(
          (await store.readEvents("failure")).events.some(
            (event) => event.kind === "gap" && event.payload.reason === "video-storage-failed",
          ),
          "failed write is recorded as a capture gap",
        );
      } finally {
        await failingManager.dispose();
      }
      return [{ group: "recording", check: "video-capture", pass: true }];
    } finally {
      await manager.dispose();
      for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
      if (!root.isDestroyed()) root.destroy();
      if (!replacement.isDestroyed()) replacement.destroy();
      if (!host.isDestroyed()) host.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
