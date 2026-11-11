const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  assert.fail(message);
}
module.exports = {
  name: "audio-capture",
  phases: ["single"],
  async run({ helpers }) {
    const { BrowserWindow } = require("electron");
    const {
      PaseoBrowserWebviewRegistry,
    } = require("../dist/features/browser-webviews/registry.js");
    const {
      BrowserRecordingCoordinator,
    } = require("../dist/features/browser-recording/coordinator.js");
    const { BrowserRecordingStore } = require("../dist/features/browser-recording/store.js");
    const {
      createVideoCaptureManager,
    } = require("../dist/features/browser-recording/video-capture.js");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-audio-test-"));
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
        targetUrl: "about:blank",
      },
    });
    await helpers.waitForInactiveReveal(handle, "audio guest host");
    const { guest } = await helpers.appendPermanentWebview({
      win: host,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: "about:blank",
    });
    await helpers.waitForGuestLoad(guest);
    await guest.executeJavaScript(
      `(()=>{window.audioProbe = new AudioContext();const osc=window.audioProbe.createOscillator();const gain=window.audioProbe.createGain();gain.gain.value=0.3;osc.frequency.value=440;osc.connect(gain).connect(window.audioProbe.destination);osc.start();return window.audioProbe.resume();})()`,
      true,
    );
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      browserId: "root",
      webContentsId: guest.id,
      hostWebContentsId: host.webContents.id,
    });
    registry.registerWorkspace({ browserId: "root", workspaceId: "fixture" });
    let popup;
    const coordinator = new BrowserRecordingCoordinator(
      registry,
      (opener, child) => opener === guest.id && popup?.webContents.id === child,
    );
    const statuses = [];
    const errors = [];
    let denyAudio = false;
    const manager = createVideoCaptureManager({
      coordinator,
      store,
      onError: (error) => errors.push(error),
      allowAudio: () => !denyAudio,
      onAudioStatus: (value) => statuses.push(value),
    });
    async function capture(id, audio) {
      await store.create({
        recordingId: id,
        workspaceId: "fixture",
        startedAt: Date.now(),
        status: "recording",
      });
      const member = coordinator.start({
        recordingId: id,
        hostWebContentsId: host.webContents.id,
        browserId: "root",
        sink: { write: (event) => store.appendEvent(id, event) },
      });
      await manager.start(id, { audio });
      let popupMember;
      if (id === "enabled") {
        popup = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
        await popup.loadURL("data:text/html,<body>audio popup</body>");
        popupMember = coordinator.addPopupFromOpen({
          openerWebContentsId: guest.id,
          popupWebContentsId: popup.webContents.id,
        });
        await popup.webContents.executeJavaScript(
          `(()=>{window.audioProbe = new AudioContext();const osc=window.audioProbe.createOscillator();const gain=window.audioProbe.createGain();gain.gain.value=0.3;osc.frequency.value=660;osc.connect(gain).connect(window.audioProbe.destination);osc.start();return window.audioProbe.resume();})()`,
          true,
        );
      }
      await eventually(async () => {
        const captured = (await store.listMediaSegmentsWithGaps(id)).segments;
        return (
          captured.filter((segment) => segment.streamId === member.memberId).length >= 2 &&
          (!popupMember ||
            captured.filter((segment) => segment.streamId === popupMember.memberId).length >= 2)
        );
      }, `${id} media is captured`);
      await coordinator.stop(id);
      const allSegments = (await store.listMediaSegmentsWithGaps(id)).segments;
      if (popupMember) {
        assert(
          allSegments.some(
            (segment) => segment.streamId === popupMember.memberId && segment.track === "combined",
          ),
          "popup audio is recorded in its own view",
        );
        assert(
          statuses.some(
            (item) => item.memberId === popupMember.memberId && item.status === "captured",
          ),
          "popup audio capture status is visible",
        );
        const popupSegments = allSegments
          .filter((segment) => segment.streamId === popupMember.memberId)
          .sort((a, b) => a.sequence - b.sequence);
        const popupBuffers = [];
        for (const segment of popupSegments)
          popupBuffers.push(
            Buffer.from(
              (await store.readMediaSegment(id, segment.streamId, segment.segmentId)).bytes,
            ),
          );
        const popupEncoded = Buffer.concat(popupBuffers).toString("base64");
        const popupPeak = await host.webContents.executeJavaScript(
          `new Promise((resolve) => {
          const video=document.createElement('video');video.src='data:video/webm;base64,${popupEncoded}';
          video.onloadedmetadata=async()=>{try{const stream=video.captureStream();if(!stream.getAudioTracks().length)return resolve(0);const ctx=new AudioContext();const analyser=ctx.createAnalyser();ctx.createMediaStreamSource(stream).connect(analyser);await ctx.resume();await video.play();let peak=0;for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,100));const data=new Uint8Array(analyser.frequencyBinCount);analyser.getByteTimeDomainData(data);peak=Math.max(peak,...data.map(x=>Math.abs(x-128)));}await ctx.close();resolve(peak)}catch{return resolve(0)}};video.onerror=()=>resolve(0);setTimeout(()=>resolve(0),6000);
        })`,
          true,
        );
        assert(popupPeak > 0, "popup audio is audible in the decoded recording");
        popup.destroy();
        popup = undefined;
      }
      const segments = allSegments
        .filter((segment) => segment.streamId === member.memberId)
        .sort((a, b) => a.sequence - b.sequence);
      assert(segments.length, `${id} has saved media`);
      return { member, segments };
    }
    try {
      const enabled = await capture("enabled", true);
      assert(
        enabled.segments.some((segment) => segment.track === "combined"),
        "enabled audio produces a combined audio/video recording",
      );
      assert(
        statuses.some((item) => item.recordingId === "enabled" && item.status === "captured"),
        "enabled audio reports captured status",
      );
      const buffers = [];
      for (const segment of enabled.segments)
        buffers.push(
          Buffer.from(
            (await store.readMediaSegment("enabled", segment.streamId, segment.segmentId)).bytes,
          ),
        );
      const encoded = Buffer.concat(buffers).toString("base64");
      const decoded = await host.webContents.executeJavaScript(
        `new Promise((resolve) => {
        const video=document.createElement('video'); video.src='data:video/webm;base64,${encoded}'; video.muted=false;
        video.onloadedmetadata=async()=>{ try { const stream=video.captureStream(); const tracks=stream.getAudioTracks().length; if (!tracks) return resolve({tracks,peak:0}); const ctx=new AudioContext(); const analyser=ctx.createAnalyser(); ctx.createMediaStreamSource(stream).connect(analyser); await ctx.resume(); await video.play(); let peak=0; for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,100)); const data=new Uint8Array(analyser.frequencyBinCount);analyser.getByteTimeDomainData(data);peak=Math.max(peak,...data.map(x=>Math.abs(x-128)));} await ctx.close(); resolve({tracks,peak}); } catch(e){resolve({error:String(e)});} }; video.onerror=()=>resolve({error:'video decode failed'}); setTimeout(()=>resolve({error:'decode timeout'}),6000);
      })`,
        true,
      );
      assert(
        decoded.tracks > 0 && decoded.peak > 0,
        `enabled audio is audible in decoded recording: ${JSON.stringify(decoded)}`,
      );
      const disabled = await capture("disabled", false);
      assert(
        disabled.segments.every((segment) => segment.track === "video"),
        "disabled audio produces video-only segments",
      );
      assert(
        !statuses.some((item) => item.recordingId === "disabled"),
        "disabled audio does not emit audio status events",
      );
      denyAudio = true;
      const denied = await capture("denied", true);
      assert(
        denied.segments.every((segment) => segment.track === "video"),
        "denied audio falls back to video-only",
      );
      assert(
        statuses.some((item) => item.recordingId === "denied" && item.status === "unavailable"),
        "denied audio is visible",
      );
      for (const [id, captureResult] of [
        ["disabled", disabled],
        ["denied", denied],
      ]) {
        const chunks = [];
        for (const segment of captureResult.segments)
          chunks.push(
            Buffer.from(
              (await store.readMediaSegment(id, segment.streamId, segment.segmentId)).bytes,
            ),
          );
        const data = Buffer.concat(chunks).toString("base64");
        const tracks = await host.webContents.executeJavaScript(`new Promise((resolve) => {
          const video = document.createElement('video');
          video.onloadedmetadata = () => resolve(video.captureStream().getAudioTracks().length);
          video.onerror = () => resolve(-1);
          video.src = 'data:video/webm;base64,${data}';
          setTimeout(() => resolve(-1), 5000);
        })`);
        assert.equal(tracks, 0, `${id} decoded video has no audio track`);
      }
      denyAudio = false;
      await store.create({
        recordingId: "transition",
        workspaceId: "fixture",
        startedAt: Date.now(),
        status: "recording",
      });
      const transitionMember = coordinator.start({
        recordingId: "transition",
        hostWebContentsId: host.webContents.id,
        browserId: "root",
        sink: { write: (event) => store.appendEvent("transition", event) },
      });
      await manager.start("transition", { audio: true });
      await eventually(
        async () =>
          (await store.listMediaSegmentsWithGaps("transition")).segments.some(
            (segment) => segment.track === "combined",
          ),
        "first generation captures audio",
      );
      denyAudio = true;
      guest.reload();
      await eventually(
        async () =>
          (await store.listMediaSegmentsWithGaps("transition")).segments.some(
            (segment) =>
              segment.streamId === transitionMember.memberId && segment.track === "video",
          ),
        "later generation without audio is labeled video-only",
      );
      await coordinator.stop("transition");
      const transitionSegments = (await store.listMediaSegmentsWithGaps("transition")).segments;
      const combinedGeneration = transitionSegments.find(
        (segment) => segment.track === "combined",
      )?.generationId;
      const videoGeneration = transitionSegments.find(
        (segment) => segment.track === "video",
      )?.generationId;
      assert(
        combinedGeneration && videoGeneration && combinedGeneration !== videoGeneration,
        "audio state resets between recording generations",
      );
      assert.deepEqual(errors, []);
      return [{ group: "recording", check: "audio-capture", pass: true }];
    } finally {
      await manager.dispose();
      if (popup && !popup.isDestroyed()) popup.destroy();
      if (!host.isDestroyed()) host.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
};
