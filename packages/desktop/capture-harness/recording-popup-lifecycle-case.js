const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  assert.fail(message);
}

module.exports = {
  name: "popup-lifecycle",
  phases: ["single"],
  async run({ helpers }) {
    const modulePath = path.join(__dirname, "../dist/features/browser-recording/lifecycle.js");
    assert.ok(fs.existsSync(modulePath), "production popup lifecycle module must exist");
    const { BrowserWindow } = require("electron");
    const {
      PaseoBrowserWebviewRegistry,
    } = require("../dist/features/browser-webviews/registry.js");
    const { createBrowserRecordingLifecycle } = require(modulePath);
    const requests = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ url: request.url, method: request.method, body });
        response.setHeader("content-type", "text/html");
        response.end("<!doctype html><title>Recording fixture</title>");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const host = new BrowserWindow({ show: false });
    const root = new BrowserWindow({ show: false });
    const created = [];
    const events = [];
    const tabs = [];
    const gaps = [];
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
      tabReservationTtlMs: 1500,
      onCdpEvent: (contents, method, params) => events.push({ id: contents.id, method, params }),
      onPopup: (popup) => created.push(popup),
      onTabOpen: (tab) => tabs.push(tab),
      onError: (error) => errors.push(error),
    });
    try {
      lifecycle.coordinator.start({
        recordingId: "fixture",
        hostWebContentsId: host.webContents.id,
        browserId: "root",
        sink: { write: async (event) => gaps.push(event) },
      });
      lifecycle.installWindowOpenHandler({
        contents: root.webContents,
        sourceContents: root.webContents,
        mainWindow: host,
      });
      await root.loadURL(`${origin}/root`);
      await helpers.withTimeout(lifecycle.ready(root.webContents.id), "root instrumentation", 5000);
      await root.webContents.executeJavaScript("fetch('/root-fetch')");
      await eventually(
        () =>
          events.some(
            (event) =>
              event.id === root.webContents.id &&
              event.method === "Network.requestWillBeSent" &&
              event.params.request.url === `${origin}/root-fetch`,
          ),
        "root tab network captured",
      );
      await root.webContents.executeJavaScript(
        `window.first = window.open(${JSON.stringify(`${origin}/first`)}, 'fixture-name', 'width=320,height=240'); true`,
      );
      await eventually(
        () => created.length === 1 && requests.some((r) => r.url === "/first"),
        "first popup opened",
      );
      const popup = created[0];
      await eventually(
        () =>
          events.some(
            (e) =>
              e.id === popup.webContents.id &&
              e.method === "Network.requestWillBeSent" &&
              e.params.request.url === `${origin}/first`,
          ),
        "capture first popup navigation",
      );
      assert.equal(
        lifecycle.coordinator.getMembership(popup.webContents.id)?.parentMemberId,
        lifecycle.coordinator.getMembership(root.webContents.id)?.memberId,
      );
      await eventually(() => !popup.webContents.isLoading(), "first popup loaded");
      await eventually(
        () =>
          events.some(
            (event) =>
              (event.method === "Page.frameNavigated" || event.method === "Page.frameSnapshot") &&
              event.params.frame?.url === `${origin}/first`,
          ),
        "popup main document attributed",
      );
      const firstFrame = events.find(
        (event) =>
          (event.method === "Page.frameNavigated" || event.method === "Page.frameSnapshot") &&
          event.params.frame?.url === `${origin}/first`,
      ).params.frame;
      assert.equal(
        lifecycle.coordinator.getFrame({
          webContentsId: popup.webContents.id,
          frameId: firstFrame.id,
        })?.documentId,
        firstFrame.loaderId,
      );
      assert.equal(await popup.webContents.executeJavaScript("window.opener !== null"), true);
      await root.webContents.executeJavaScript(
        "window.addEventListener('message', (event) => { window.fixtureMessage = event.data; }); true",
      );
      await popup.webContents.executeJavaScript(
        "window.opener.postMessage('fixture-message', '*'); true",
      );
      await eventually(
        async () =>
          (await root.webContents.executeJavaScript("window.fixtureMessage")) === "fixture-message",
        "popup can message its opener",
      );
      await root.webContents.executeJavaScript(
        `window.second = window.open(${JSON.stringify(`${origin}/reuse`)}, 'fixture-name', 'width=320,height=240'); true`,
      );
      await eventually(() => requests.some((r) => r.url === "/reuse"), "named popup navigated");
      assert.equal(created.length, 1, "named window must be reused");
      assert.equal(
        await root.webContents.executeJavaScript("window.first === window.second"),
        true,
      );
      await eventually(() => !popup.webContents.isLoading(), "reused popup loaded");
      await popup.webContents.executeJavaScript(
        `window.open(${JSON.stringify(`${origin}/nested`)}, 'nested', 'width=320,height=240'); true`,
      );
      await eventually(
        () => created.length === 2 && requests.some((r) => r.url === "/nested"),
        "nested popup opened",
      );
      assert.equal(
        lifecycle.coordinator.getMembership(created[1].webContents.id)?.parentMemberId,
        lifecycle.coordinator.getMembership(popup.webContents.id)?.memberId,
      );
      await root.webContents.executeJavaScript(
        `const f = document.createElement('form'); f.method = 'POST'; f.action = ${JSON.stringify(`${origin}/post`)}; f.target = 'post-popup'; const i = document.createElement('input'); i.name = 'fixture'; i.value = 'value'; f.appendChild(i); document.body.appendChild(f); f.submit(); true`,
      );
      await eventually(() => requests.some((r) => r.url === "/post"), "POST popup opened");
      assert.deepEqual(
        requests.find((r) => r.url === "/post"),
        { url: "/post", method: "POST", body: "fixture=value" },
      );
      await root.webContents.executeJavaScript(
        `window.open(${JSON.stringify(`${origin}/tab`)}, '_blank'); true`,
      );
      await eventually(() => tabs.length === 1, "workspace tab requested");
      assert.ok(tabs[0].browserId, "opened tab receives a reserved browser ID");
      const tab = new BrowserWindow({ show: false });
      try {
        await tab.loadURL(`${origin}/tab-before-attach`);
        registry.registerWebContents({
          browserId: tabs[0].browserId,
          webContentsId: tab.webContents.id,
          hostWebContentsId: host.webContents.id,
        });
        registry.registerWorkspace({ browserId: tabs[0].browserId, workspaceId: "fixture" });
        lifecycle.attached(host.webContents.id + 10000, tabs[0].browserId);
        assert.equal(
          lifecycle.coordinator.getMembership(tab.webContents.id),
          null,
          "another host cannot claim the reservation",
        );
        lifecycle.attached(host.webContents.id, tabs[0].browserId);
        assert.equal(
          lifecycle.coordinator.getMembership(tab.webContents.id)?.parentMemberId,
          lifecycle.coordinator.getMembership(root.webContents.id)?.memberId,
        );
        await helpers.withTimeout(lifecycle.ready(tab.webContents.id), "tab instrumentation", 5000);
        await tab.loadURL(`${origin}/tab-capture`);
        await eventually(
          () =>
            events.some(
              (event) =>
                event.id === tab.webContents.id &&
                event.method === "Network.requestWillBeSent" &&
                event.params.request.url === `${origin}/tab-capture`,
            ),
          "claimed tab network captured",
        );
        const originalId = lifecycle.coordinator.getMembership(tab.webContents.id).memberId;
        const replacement = new BrowserWindow({ show: false });
        try {
          await replacement.loadURL(`${origin}/replacement-before-attach`);
          registry.registerWebContents({
            browserId: tabs[0].browserId,
            webContentsId: replacement.webContents.id,
            hostWebContentsId: host.webContents.id,
          });
          lifecycle.attached(host.webContents.id, tabs[0].browserId);
          assert.equal(lifecycle.coordinator.getMembership(tab.webContents.id), null);
          assert.equal(
            lifecycle.coordinator.getMembership(replacement.webContents.id)?.memberId,
            originalId,
          );
          await helpers.withTimeout(
            lifecycle.ready(replacement.webContents.id),
            "replacement instrumentation",
            5000,
          );
          const previousEventCount = events.filter(
            (event) => event.id === tab.webContents.id,
          ).length;
          await tab.loadURL(`${origin}/old-guest-after-replacement`);
          await sleep(100);
          assert.equal(
            events.filter((event) => event.id === tab.webContents.id).length,
            previousEventCount,
            "replaced guest no longer emits recording events",
          );
          await replacement.loadURL(`${origin}/replacement`);
          await eventually(
            () =>
              events.some(
                (event) =>
                  event.id === replacement.webContents.id &&
                  event.method === "Network.requestWillBeSent" &&
                  event.params.request.url === `${origin}/replacement`,
              ),
            "replacement guest network captured",
          );
        } finally {
          replacement.destroy();
        }
        await eventually(
          () =>
            gaps.some(
              (event) => event.payload?.reason === "tab-first-navigation-before-attachment",
            ),
          "late tab attachment records its capture gap",
        );
      } finally {
        tab.destroy();
      }
      await popup.webContents.executeJavaScript(
        `const iframe = document.createElement('iframe'); iframe.id = 'recorded-frame'; iframe.src = ${JSON.stringify(`${origin}/frame-one`)}; document.body.appendChild(iframe); true`,
      );
      await eventually(
        () =>
          events.some(
            (event) =>
              event.method === "Page.frameNavigated" &&
              event.params.frame?.url === `${origin}/frame-one`,
          ),
        "frame navigation observed",
      );
      const frame = events.find(
        (event) =>
          event.method === "Page.frameNavigated" &&
          event.params.frame?.url === `${origin}/frame-one`,
      ).params.frame;
      assert.equal(
        lifecycle.coordinator.getFrame({ webContentsId: popup.webContents.id, frameId: frame.id })
          ?.documentId,
        frame.loaderId,
      );
      await popup.webContents.executeJavaScript(
        `document.getElementById('recorded-frame').src = ${JSON.stringify(`${origin}/frame-two`)}; true`,
      );
      await eventually(
        () =>
          events.some(
            (event) =>
              event.method === "Page.frameNavigated" &&
              event.params.frame?.url === `${origin}/frame-two`,
          ),
        "frame renavigation observed",
      );
      const nextFrame = events.find(
        (event) =>
          event.method === "Page.frameNavigated" &&
          event.params.frame?.url === `${origin}/frame-two`,
      ).params.frame;
      assert.equal(
        lifecycle.coordinator.getFrame({ webContentsId: popup.webContents.id, frameId: frame.id })
          ?.documentId,
        nextFrame.loaderId,
      );
      const crossOrigin = `http://localhost:${server.address().port}/frame-cross`;
      await popup.webContents.executeJavaScript(
        `document.getElementById('recorded-frame').src = ${JSON.stringify(crossOrigin)}; true`,
      );
      await eventually(
        () => requests.some((request) => request.url === "/frame-cross"),
        "cross-origin frame navigated",
      );
      await eventually(
        () =>
          events.some(
            (event) =>
              (event.method === "Page.frameNavigated" || event.method === "Page.frameSnapshot") &&
              event.params.frame?.url === crossOrigin,
          ),
        "cross-origin frame observed",
      );
      const crossFrame = events.find(
        (event) =>
          (event.method === "Page.frameNavigated" || event.method === "Page.frameSnapshot") &&
          event.params.frame?.url === crossOrigin,
      ).params.frame;
      assert.equal(
        lifecycle.coordinator.getFrame({
          webContentsId: popup.webContents.id,
          frameId: crossFrame.id,
        })?.documentId,
        crossFrame.loaderId,
      );
      await eventually(
        () =>
          gaps.some((event) => event.payload?.reason === "child-target-attached-after-navigation"),
        "late child target attachment reports a gap",
      );
      await root.webContents.executeJavaScript(
        `window.open(${JSON.stringify(`${origin}/expire`)}, '_blank'); true`,
      );
      await eventually(() => tabs.length === 2, "second tab reserved");
      await eventually(
        () => gaps.some((event) => event.payload?.reason === "tab-claim-expired"),
        "unclaimed tab emits a gap when the reservation expires",
      );
      const nestedPopup = created[1];
      await eventually(() => !nestedPopup.webContents.isLoading(), "nested popup loaded");
      const nestedId = nestedPopup.webContents.id;
      await nestedPopup.webContents.executeJavaScript(
        `window.open(${JSON.stringify(`${origin}/popup-tab`)}, '_blank'); window.close(); true`,
      );
      await eventually(
        () => tabs.length === 3 && lifecycle.coordinator.getMembership(nestedId) === null,
        "popup tab reservation outlives closed opener",
      );
      const orphanTab = new BrowserWindow({ show: false });
      try {
        await orphanTab.loadURL(`${origin}/orphan-tab`);
        registry.registerWebContents({
          browserId: tabs[2].browserId,
          webContentsId: orphanTab.webContents.id,
          hostWebContentsId: host.webContents.id,
        });
        registry.registerWorkspace({ browserId: tabs[2].browserId, workspaceId: "fixture" });
        lifecycle.attached(host.webContents.id, tabs[2].browserId);
        await eventually(
          () =>
            gaps.some(
              (event) =>
                event.payload?.reason === "tab-claim-failed" &&
                event.memberId ===
                  lifecycle.coordinator.getMembership(root.webContents.id)?.memberId,
            ),
          "closed opener claim failure attributed to root",
        );
        assert.match(String(errors.pop()), /not associated with a live recording/);
      } finally {
        orphanTab.destroy();
      }
      const guestHost = helpers.createInactiveHarnessWindow({
        width: 800,
        height: 600,
        webPreferences: {
          webviewTag: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      try {
        helpers.installHarnessWebviewGuards(guestHost.win, {
          preloadPath: helpers.guestPreloadPath,
        });
        const tracker = helpers.trackAttachedGuests(guestHost.win);
        await guestHost.win.loadFile(path.join(helpers.harnessRoot, "index.html"), {
          query: {
            webviewCount: "0",
            permanentParkingState: "p1-overflow-1x1",
            targetUrl: `${origin}/`,
          },
        });
        await helpers.waitForInactiveReveal(guestHost, "popup lifecycle guest");
        const { guest } = await helpers.appendPermanentWebview({
          win: guestHost.win,
          tracker,
          state: { id: "p1-overflow-1x1" },
          sourceUrl: `${origin}/guest`,
        });
        await helpers.waitForGuestLoad(guest);
        registry.registerWebContents({
          browserId: "guest",
          webContentsId: guest.id,
          hostWebContentsId: guestHost.win.webContents.id,
        });
        registry.registerWorkspace({ browserId: "guest", workspaceId: "fixture" });
        lifecycle.coordinator.start({
          recordingId: "guest-fixture",
          hostWebContentsId: guestHost.win.webContents.id,
          browserId: "guest",
          sink: { write: async () => {} },
        });
        lifecycle.installWindowOpenHandler({
          contents: guest,
          sourceContents: guest,
          mainWindow: guestHost.win,
        });
        const before = created.length;
        await guest.executeJavaScript(
          `window.open(${JSON.stringify(`${origin}/guest-popup`)}, 'guest-popup', 'width=320,height=240'); true`,
        );
        await eventually(
          () => created.length === before + 1 && requests.some((r) => r.url === "/guest-popup"),
          "webview popup opened",
        );
        const guestPopup = created[before];
        await eventually(
          () =>
            events.some(
              (e) =>
                e.id === guestPopup.webContents.id &&
                e.method === "Network.requestWillBeSent" &&
                e.params.request.url === `${origin}/guest-popup`,
            ),
          "webview popup first request captured",
        );
        assert.equal(
          lifecycle.coordinator.getMembership(guestPopup.webContents.id)?.parentMemberId,
          lifecycle.coordinator.getMembership(guest.id)?.memberId,
        );
        await lifecycle.coordinator.stop("guest-fixture");
        await sleep(200);
      } finally {
        await helpers.closeHarnessWindow(guestHost.win);
      }
      const unrecorded = new BrowserWindow({ show: false });
      try {
        await unrecorded.loadURL(`${origin}/unrecorded`);
        lifecycle.installWindowOpenHandler({
          contents: unrecorded.webContents,
          sourceContents: unrecorded.webContents,
          mainWindow: host,
        });
        const before = created.length;
        await unrecorded.webContents.executeJavaScript(
          `window.open(${JSON.stringify(`${origin}/unrecorded-popup`)}, 'unrecorded-popup', 'width=320,height=240'); true`,
        );
        await eventually(
          () =>
            created.length === before + 1 &&
            requests.some((request) => request.url === "/unrecorded-popup"),
          "unrecorded popup opened",
        );
        assert.equal(lifecycle.coordinator.getMembership(created[before].webContents.id), null);
      } finally {
        unrecorded.destroy();
      }
      await lifecycle.coordinator.stop("fixture");
      await sleep(200);
      const countBeforeStoppedFetch = events.filter(
        (event) => event.id === root.webContents.id,
      ).length;
      await root.webContents.executeJavaScript("fetch('/after-stop')");
      await sleep(100);
      assert.equal(
        events.filter((event) => event.id === root.webContents.id).length,
        countBeforeStoppedFetch,
        "CDP recording consumer is released on stop",
      );
      assert.deepEqual(errors, [], "lifecycle setup and cleanup must not fail");
      return [{ group: "recording", check: "popup-lifecycle", pass: true }];
    } finally {
      for (const popup of created) if (!popup.isDestroyed()) popup.destroy();
      if (!root.isDestroyed()) root.destroy();
      if (!host.isDestroyed()) host.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
