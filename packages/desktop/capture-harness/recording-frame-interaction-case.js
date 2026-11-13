const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate, message) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  assert.fail(message);
}
function click(contents, x, y) {
  contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

module.exports = {
  name: "frame-interaction",
  phases: ["single"],
  async run({ helpers }) {
    const modulePath = path.join(
      __dirname,
      "../dist/features/browser-recording/interaction-recorder.js",
    );
    assert.ok(fs.existsSync(modulePath), "production interaction recorder must exist");
    const { ipcMain } = require("electron");
    const { getSharedCdpSession } = require("../dist/features/browser-automation/ipc.js");
    const {
      PaseoBrowserWebviewRegistry,
    } = require("../dist/features/browser-webviews/registry.js");
    const {
      createBrowserRecordingLifecycle,
    } = require("../dist/features/browser-recording/lifecycle.js");
    const { createInteractionRecorder } = require(modulePath);
    const {
      browserRecordingPopupOptions,
    } = require("../dist/features/browser-recording/popup-options.js");
    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/child") {
        response.end(
          `<!doctype html><style>body{margin:0}button{position:absolute;left:10px;top:10px;width:120px;height:30px}</style><button id="frame-button">Frame action</button>`,
        );
      } else if (request.url === "/next") {
        response.end(`<!doctype html><button id="after">After navigation</button>`);
      } else {
        response.end(
          `<!doctype html><style>body{margin:0}button,a{position:absolute;left:10px;width:120px;height:30px}#main{top:10px}#keyboard{top:50px}#nav{top:90px}iframe{position:absolute;left:0;top:150px;width:400px;height:150px;border:0}</style><button id="main">Main action</button><button id="keyboard">Keyboard action</button><a id="nav" href="/next">Navigate</a>`,
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const handle = helpers.createInactiveHarnessWindow({
      width: 1000,
      height: 700,
      webPreferences: {
        webviewTag: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    const errors = [];
    const events = [];
    const cdpEvents = [];
    const popups = [];
    let capture;
    let automation;
    const registry = new PaseoBrowserWebviewRegistry();
    const lifecycle = createBrowserRecordingLifecycle({
      registry,
      onTabOpen: () => {},
      onPopup: (popup) => popups.push(popup),
      popupOptions: (mainWindow) =>
        browserRecordingPopupOptions(mainWindow, helpers.guestPreloadPath),
      onError: (error) => errors.push(error),
      onCdpEvent: (...args) => {
        cdpEvents.push(args);
        capture?.onCdpEvent(...args);
      },
    });
    capture = createInteractionRecorder({
      coordinator: lifecycle.coordinator,
      ipc: ipcMain,
      onError: (error) => errors.push(error),
    });
    capture.registerIpc();
    try {
      helpers.installHarnessWebviewGuards(handle.win, { preloadPath: helpers.guestPreloadPath });
      const tracker = helpers.trackAttachedGuests(handle.win);
      await handle.win.loadFile(path.join(helpers.harnessRoot, "index.html"), {
        query: {
          webviewCount: "0",
          permanentParkingState: "p1-overflow-1x1",
          targetUrl: `${origin}/`,
        },
      });
      await helpers.waitForInactiveReveal(handle, "frame interaction");
      const { guest } = await helpers.appendPermanentWebview({
        win: handle.win,
        tracker,
        state: { id: "p1-overflow-1x1" },
        sourceUrl: `${origin}/root`,
      });
      await helpers.waitForGuestLoad(guest);
      await handle.win.webContents.executeJavaScript(
        `Object.assign(document.getElementById('paseo-browser-resident-webviews').style,{width:'1000px',height:'700px',pointerEvents:'auto',overflow:'visible'}); true`,
      );
      registry.registerWebContents({
        browserId: "root",
        webContentsId: guest.id,
        hostWebContentsId: handle.win.webContents.id,
      });
      registry.registerWorkspace({ browserId: "root", workspaceId: "fixture" });
      lifecycle.installWindowOpenHandler({
        contents: guest,
        sourceContents: guest,
        mainWindow: handle.win,
      });
      automation = getSharedCdpSession(guest).createConsumer({});
      await automation.enableDomain("Runtime");
      lifecycle.coordinator.start({
        recordingId: "fixture",
        hostWebContentsId: handle.win.webContents.id,
        browserId: "root",
        sink: { write: async (event) => events.push(event) },
      });
      await eventually(
        () => capture.getFrameCount(guest.id) >= 1,
        "root frame mapped to CDP document",
      );
      assert.equal(
        await guest.executeJavaScript("typeof window.__paseoRecordingNonce"),
        "undefined",
        "page cannot read preload marker",
      );
      assert.equal(
        await guest.executeJavaScript("typeof window.process"),
        "undefined",
        "page cannot access the Node process",
      );
      assert.equal(
        await guest.executeJavaScript("typeof window.require"),
        "undefined",
        "page cannot access node APIs",
      );
      guest.focus();
      click(guest, 30, 20);
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "main",
          ),
        "trusted mouse click captured",
      );
      const main = events.find(
        (event) => event.kind === "interaction" && event.payload.element.id === "main",
      );
      assert.equal(main.frameAttribution, "identified");
      assert.ok(main.frameId);
      assert.ok(main.documentId);
      assert.equal(main.payload.origin, "unknown");
      await guest.executeJavaScript(
        `const longButton = document.createElement('button'); longButton.id='long-label'; longButton.setAttribute('aria-label', 'x'.repeat(400)); Object.assign(longButton.style,{left:'160px',top:'10px'}); document.body.appendChild(longButton); true`,
      );
      click(guest, 175, 20);
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "long-label",
          ),
        "bounded element label captured",
      );
      const bounded = events.find(
        (event) => event.kind === "interaction" && event.payload.element.id === "long-label",
      );
      assert.equal(bounded.payload.element.label.length, 256);
      assert.equal(bounded.payload.element.truncated, true);
      const beforeForgery = events.filter((event) => event.kind === "interaction").length;
      ipcMain.emit(
        "paseo:browser-recording-document",
        { sender: guest, senderFrame: guest.mainFrame },
        { nonce: "f".repeat(32) },
      );
      ipcMain.emit(
        "paseo:browser-recording-click",
        { sender: guest, senderFrame: guest.mainFrame },
        {
          nonce: "f".repeat(32),
          at: Date.now(),
          activation: "pointer",
          button: "primary",
          modifiers: { alt: false, control: false, meta: false, shift: false },
          element: {
            tag: "button",
            id: "forged",
            name: "",
            role: "",
            label: "",
            href: "",
            truncated: false,
          },
        },
      );
      await eventually(
        () =>
          events.some(
            (event) =>
              event.kind === "gap" && event.payload.reason === "interaction-document-unverified",
          ),
        "guessed nonce is rejected with a gap",
      );
      assert.equal(
        events.filter((event) => event.kind === "interaction").length,
        beforeForgery,
        "guessed nonce cannot forge a click",
      );
      const beforeSynthetic = events.filter((event) => event.kind === "interaction").length;
      await guest.executeJavaScript("document.querySelector('#main').click(); true");
      await sleep(150);
      assert.equal(
        events.filter((event) => event.kind === "interaction").length,
        beforeSynthetic,
        "scripted clicks are excluded",
      );
      await guest.executeJavaScript("document.querySelector('#keyboard').focus(); true");
      handle.win.show();
      handle.win.focus();
      await handle.win.webContents.executeJavaScript(
        "document.getElementById('target-webview-1').focus(); true",
      );
      guest.focus();
      await guest.executeJavaScript("document.querySelector('#keyboard').focus(); true");
      await eventually(
        () => guest.executeJavaScript("document.hasFocus()"),
        "guest has keyboard focus",
      );
      guest.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      guest.sendInputEvent({ type: "char", keyCode: "Enter" });
      guest.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "keyboard",
          ),
        "keyboard activation captured",
      );
      assert.equal(
        events.find(
          (event) => event.kind === "interaction" && event.payload.element.id === "keyboard",
        ).payload.activation,
        "keyboard-or-assistive",
      );
      await guest.executeJavaScript(
        `const middle = document.createElement('button'); middle.id='middle'; middle.textContent='Middle'; Object.assign(middle.style,{left:'160px',top:'50px'}); document.body.appendChild(middle); const label=document.createElement('label'); label.id='label'; label.htmlFor='checkbox'; label.textContent='Toggle'; Object.assign(label.style,{position:'absolute',left:'160px',top:'100px',width:'120px',height:'30px'}); const box=document.createElement('input'); box.type='checkbox'; box.id='checkbox'; Object.assign(box.style,{position:'absolute',left:'320px',top:'100px'}); document.body.append(label,box); true`,
      );
      guest.sendInputEvent({ type: "mouseDown", x: 175, y: 60, button: "middle", clickCount: 1 });
      guest.sendInputEvent({ type: "mouseUp", x: 175, y: 60, button: "middle", clickCount: 1 });
      await eventually(
        () =>
          events.some(
            (event) =>
              event.kind === "interaction" &&
              event.payload.element.id === "middle" &&
              event.payload.button === "middle",
          ),
        "middle-click activation captured",
      );
      click(guest, 175, 110);
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "label",
          ),
        "label activation captured",
      );
      await eventually(
        () => guest.executeJavaScript("document.querySelector('#checkbox').checked"),
        "label activated its control",
      );
      await sleep(100);
      assert.equal(
        events.filter(
          (event) => event.kind === "interaction" && event.payload.element.id === "checkbox",
        ).length,
        0,
        "forwarded label click is not duplicated",
      );
      await guest.executeJavaScript(
        `const visible=document.createElement('button'); visible.id='visible-label'; visible.innerHTML='Visible<span hidden>unrelated hidden text</span><script>unrelated script</script>'; Object.assign(visible.style,{left:'350px',top:'10px'}); const area=document.createElement('textarea'); area.id='editable'; area.textContent='private editor text'; Object.assign(area.style,{position:'absolute',left:'350px',top:'50px',width:'120px',height:'30px'}); const link=document.createElement('a'); link.id='query-link'; link.href='/next?token=synthetic#section'; link.textContent='Link'; link.onclick=(event)=>event.preventDefault(); Object.assign(link.style,{left:'350px',top:'100px'}); document.body.append(visible,area,link); true`,
      );
      click(guest, 370, 20);
      click(guest, 370, 60);
      click(guest, 370, 110);
      await eventually(
        () =>
          ["visible-label", "editable", "query-link"].every((id) =>
            events.some((event) => event.kind === "interaction" && event.payload.element.id === id),
          ),
        "visible labels and links captured",
      );
      assert.equal(
        events.find(
          (event) => event.kind === "interaction" && event.payload.element.id === "visible-label",
        ).payload.element.label,
        "Visible",
      );
      assert.equal(
        events.find(
          (event) => event.kind === "interaction" && event.payload.element.id === "editable",
        ).payload.element.label,
        "",
      );
      assert.ok(
        events
          .find(
            (event) => event.kind === "interaction" && event.payload.element.id === "query-link",
          )
          .payload.element.href.endsWith("/next?token=synthetic#section"),
        "full link data is retained for explicit sharing",
      );
      await guest.executeJavaScript(
        `const nested=document.createElement('button'); nested.id='nested-action'; nested.innerHTML='<span style="display:block;width:100%;height:100%">Save</span>'; Object.assign(nested.style,{left:'500px',top:'10px'}); const exact=document.createElement('button'); exact.id='exact-label'; exact.textContent='e'.repeat(256); Object.assign(exact.style,{left:'500px',top:'50px'}); const wrap=document.createElement('label'); wrap.id='wrapped'; Object.assign(wrap.style,{position:'absolute',left:'500px',top:'100px',width:'120px',height:'30px'}); const input=document.createElement('input'); input.id='wrapped-control'; input.type='checkbox'; wrap.append(input,'Wrapped'); document.body.append(nested,exact,wrap); true`,
      );
      click(guest, 515, 20);
      click(guest, 515, 60);
      click(guest, 508, 110);
      click(guest, 508, 110);
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "nested-action",
          ),
        "nested actionable element identified",
      );
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "exact-label",
          ),
        "exact-length label captured",
      );
      await eventually(
        () =>
          events.filter(
            (event) =>
              event.kind === "interaction" && event.payload.element.id === "wrapped-control",
          ).length === 2,
        "distinct direct control clicks are retained",
      );
      assert.equal(
        events.find(
          (event) => event.kind === "interaction" && event.payload.element.id === "nested-action",
        ).payload.element.label,
        "Save",
      );
      assert.equal(
        events.find(
          (event) => event.kind === "interaction" && event.payload.element.id === "exact-label",
        ).payload.element.truncated,
        false,
      );
      await guest.executeJavaScript(
        `const spaced=document.createElement('button'); spaced.id='spaced-label'; spaced.textContent=' '.repeat(400)+'Save'+' '.repeat(400); Object.assign(spaced.style,{left:'650px',top:'10px'}); document.body.appendChild(spaced); true`,
      );
      click(guest, 665, 20);
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "spaced-label",
          ),
        "whitespace-heavy label captured",
      );
      const spacedEvent = events.find(
        (event) => event.kind === "interaction" && event.payload.element.id === "spaced-label",
      );
      assert.equal(spacedEvent.payload.element.label, "Save");
      assert.equal(spacedEvent.payload.element.truncated, false);
      guest.sendInputEvent({
        type: "mouseDown",
        x: 370,
        y: 110,
        button: "left",
        clickCount: 1,
        modifiers: ["control"],
      });
      guest.sendInputEvent({
        type: "mouseUp",
        x: 370,
        y: 110,
        button: "left",
        clickCount: 1,
        modifiers: ["control"],
      });
      await eventually(
        () =>
          events.some(
            (event) =>
              event.kind === "interaction" &&
              event.payload.element.id === "query-link" &&
              event.payload.modifiers.control === true,
          ),
        "control-click modifiers captured",
      );
      await guest.executeJavaScript(
        `const f=document.createElement('iframe'); f.src=${JSON.stringify(`http://localhost:${port}/child`)}; document.body.appendChild(f); true`,
      );
      await eventually(
        () => capture.getFrameCount(guest.id) >= 2,
        "cross-origin child frame mapped",
      );
      const childTarget = cdpEvents.find(
        (args) => args[1] === "Target.attachedToTarget" && args[2].targetInfo?.type === "iframe",
      );
      assert.ok(childTarget?.[2].sessionId, "cross-origin frame has a debugger session");
      await guest.debugger.sendCommand(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 30, y: 20, button: "left", clickCount: 1 },
        childTarget[2].sessionId,
      );
      await guest.debugger.sendCommand(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x: 30, y: 20, button: "left", clickCount: 1 },
        childTarget[2].sessionId,
      );
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "frame-button",
          ),
        "cross-origin frame click captured",
      );
      const frame = events.find(
        (event) => event.kind === "interaction" && event.payload.element.id === "frame-button",
      );
      assert.equal(frame.frameAttribution, "identified");
      assert.ok(frame.documentId);
      assert.notEqual(frame.frameId, main.frameId);
      assert.equal(
        frame.payload.origin,
        "unknown",
        "automation-origin clicks are not misidentified as human",
      );
      click(guest, 30, 100);
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "nav",
          ),
        "navigation click captured before unload",
      );
      await eventually(() => guest.getURL().endsWith("/next"), "navigation completed");
      await eventually(() => capture.getFrameCount(guest.id) >= 1, "replacement document mapped");
      guest.focus();
      click(guest, 25, 18);
      await eventually(
        () =>
          events.some(
            (event) => event.kind === "interaction" && event.payload.element.id === "after",
          ),
        "click after navigation captured",
      );
      const after = events.find(
        (event) => event.kind === "interaction" && event.payload.element.id === "after",
      );
      assert.notEqual(
        after.documentId,
        main.documentId,
        "navigation creates a new document identity",
      );
      const beforeReload = events.filter(
        (event) => event.kind === "interaction" && event.payload.element.id === "after",
      ).length;
      const loaded = new Promise((resolve) => guest.once("did-finish-load", resolve));
      guest.reload();
      await helpers.withTimeout(loaded, "page refresh", 5000);
      await eventually(() => capture.getFrameCount(guest.id) >= 1, "refreshed document mapped");
      await eventually(
        () =>
          capture
            .getFrameDocuments(guest.id)
            .some(
              (document) =>
                document.frameId === after.frameId && document.documentId !== after.documentId,
            ),
        "new refresh identity mapped",
      );
      guest.focus();
      click(guest, 25, 18);
      await eventually(
        () =>
          events.filter(
            (event) => event.kind === "interaction" && event.payload.element.id === "after",
          ).length > beforeReload,
        "click after refresh captured",
      );
      const refreshed = events.findLast(
        (event) => event.kind === "interaction" && event.payload.element.id === "after",
      );
      assert.notEqual(
        refreshed.documentId,
        after.documentId,
        "refresh creates a new document identity",
      );
      await guest.executeJavaScript(
        `window.open(${JSON.stringify(`${origin}/popup`)}, 'recorded-popup', 'width=320,height=240'); true`,
      );
      await eventually(
        () => popups.length === 1 && !popups[0].webContents.isLoading(),
        "recorded popup loaded",
      );
      const popup = popups[0];
      await eventually(
        () => capture.getFrameCount(popup.webContents.id) >= 1,
        "popup document mapped",
      );
      popup.focus();
      click(popup.webContents, 30, 20);
      await eventually(
        () =>
          events.some(
            (event) =>
              event.kind === "interaction" &&
              event.webContentsId === popup.webContents.id &&
              event.payload.element.id === "main",
          ),
        "popup click captured",
      );
      assert.equal(
        await popup.webContents.executeJavaScript("typeof window.require"),
        "undefined",
        "popup page cannot access Node APIs",
      );
      assert.equal(
        await popup.webContents.executeJavaScript("typeof window.__paseoRecordingNonce"),
        "undefined",
        "popup page cannot read preload marker",
      );
      const popupEvent = events.find(
        (event) =>
          event.kind === "interaction" &&
          event.webContentsId === popup.webContents.id &&
          event.payload.element.id === "main",
      );
      assert.equal(popupEvent.frameAttribution, "identified");
      assert.equal(
        lifecycle.coordinator.getMembership(popup.webContents.id)?.parentMemberId,
        main.memberId,
      );
      await sleep(150);
      assert.equal(
        events.filter(
          (event) =>
            event.kind === "interaction" &&
            event.webContentsId === guest.id &&
            event.payload.element.id === "main",
        ).length,
        1,
        "one mouse click produces one event",
      );
      assert.equal(
        events.filter(
          (event) => event.kind === "interaction" && event.payload.element.id === "keyboard",
        ).length,
        1,
        "one keyboard activation produces one event",
      );
      assert.equal(
        events.filter(
          (event) => event.kind === "interaction" && event.payload.element.id === "frame-button",
        ).length,
        1,
        "one iframe click produces one event",
      );
      const { guest: replacement } = await helpers.appendPermanentWebview({
        win: handle.win,
        tracker,
        state: { id: "p1-overflow-1x1" },
        sourceUrl: `${origin}/next`,
      });
      await helpers.waitForGuestLoad(replacement);
      await handle.win.webContents.executeJavaScript(
        `Object.assign(document.getElementById('paseo-browser-resident-webviews').style,{width:'1000px',height:'700px',pointerEvents:'auto',overflow:'visible'}); true`,
      );
      registry.registerWebContents({
        browserId: "root",
        webContentsId: replacement.id,
        hostWebContentsId: handle.win.webContents.id,
      });
      registry.registerWorkspace({ browserId: "root", workspaceId: "fixture" });
      lifecycle.installWindowOpenHandler({
        contents: replacement,
        sourceContents: replacement,
        mainWindow: handle.win,
      });
      lifecycle.attached(handle.win.webContents.id, "root");
      assert.equal(
        lifecycle.coordinator.getMembership(replacement.id)?.memberId,
        main.memberId,
        "replacement keeps the logical member identity",
      );
      await eventually(
        () => capture.getFrameCount(replacement.id) >= 1,
        "replacement guest document mapped",
      );
      replacement.focus();
      click(replacement, 25, 18);
      await eventually(
        () =>
          events.some(
            (event) =>
              event.kind === "interaction" &&
              event.webContentsId === replacement.id &&
              event.payload.element.id === "after",
          ),
        "replacement guest click captured",
      );
      const replacementEvent = events.find(
        (event) =>
          event.kind === "interaction" &&
          event.webContentsId === replacement.id &&
          event.payload.element.id === "after",
      );
      assert.equal(replacementEvent.frameAttribution, "identified");
      assert.deepEqual(errors, []);
      await lifecycle.coordinator.stop("fixture");
      await sleep(100);
      const stoppedCount = events.filter((event) => event.kind === "interaction").length;
      guest.focus();
      click(guest, 25, 18);
      await sleep(150);
      assert.equal(
        events.filter((event) => event.kind === "interaction").length,
        stoppedCount,
        "stopped recordings capture no further clicks",
      );
      const result = await automation.sendCommand("Runtime.evaluate", {
        expression: "1+1",
        returnByValue: true,
      });
      assert.equal(result.result.value, 2, "automation remains usable after recording stops");
      await automation.release();
      automation = null;
      return [{ group: "recording", check: "frame-interaction", pass: true }];
    } finally {
      capture.dispose();
      if (automation) await automation.release().catch(() => {});
      for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
      await helpers.closeHarnessWindow(handle.win);
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
