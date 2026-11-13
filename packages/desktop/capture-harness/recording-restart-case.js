const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

module.exports = {
  name: "restart",
  phases: ["write", "read"],
  async run({ phase, outDir, runId }) {
    assert.match(runId || "", /^[0-9a-f-]{36}$/);
    const root = path.join(outDir, `recording-restart-${runId}`);
    const { BrowserRecordingStore } = require("../dist/features/browser-recording/store.js");
    const store = new BrowserRecordingStore(root);
    if (phase === "write") {
      await store.create({
        recordingId: "active",
        workspaceId: "fixture",
        startedAt: 1,
        status: "recording",
      });
      await store.create({
        recordingId: "saved",
        workspaceId: "fixture",
        startedAt: 1,
        status: "complete",
      });
      await store.appendEvent("active", {
        recordingId: "active",
        memberId: "tab",
        webContentsId: 1,
        frameAttribution: "unattributed",
        kind: "interaction",
        payload: { text: "persisted click" },
      });
      await store.writeMediaSegment("active", {
        streamId: "tab",
        segmentId: "segment",
        startMs: 0,
        durationMs: 1,
        mimeType: "video/webm",
        bytes: Uint8Array.from([1, 2, 3]),
      });
      await fs.writeFile(path.join(root, "writer-pid"), String(process.pid));
      return [{ group: "recording", check: "restart-write", pass: true }];
    }
    try {
      assert.notEqual(
        Number(await fs.readFile(path.join(root, "writer-pid"), "utf8")),
        process.pid,
        "restart uses a different Electron process",
      );
      let startup = async () => null;
      try {
        ({
          recoverBrowserRecordingsOnStartup: startup,
        } = require("../dist/features/browser-recording/startup-recovery.js"));
      } catch (error) {
        if (
          error.code !== "MODULE_NOT_FOUND" ||
          !error.message.startsWith(
            "Cannot find module '../dist/features/browser-recording/startup-recovery.js'",
          )
        )
          throw error;
      }
      assert.equal(await startup(store, true), null, "startup recovery must succeed");
      assert.equal(
        (await store.readMetadata("active")).status,
        "interrupted",
        "startup must mark the active recording interrupted",
      );
      assert.equal((await store.readMetadata("saved")).status, "complete");
      assert.equal((await store.readEvents("active")).events[0].payload.text, "persisted click");
      assert.deepEqual(
        [...(await store.readMediaSegment("active", "tab", "segment")).bytes],
        [1, 2, 3],
      );
      return [{ group: "recording", check: "restart-interruption", pass: true }];
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
};
