import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, ipcMain, session, webContents, type WebContents } from "electron";
import type { BrowserRecordingCoordinator, RecordingMembership } from "./coordinator.js";
import type { BrowserRecordingStore } from "./store.js";
import { holdFrameProduction } from "../browser-automation/frame-production.js";

interface Options {
  coordinator: BrowserRecordingCoordinator;
  store: BrowserRecordingStore;
  onError: (error: unknown) => void;
  onStorageError?: (recordingId: string, error: unknown) => void;
}
interface View {
  member: RecordingMembership;
  target: WebContents;
  stop: () => Promise<void>;
  done: () => Promise<void>;
}
interface Active {
  baseOffset: number;
  baseMonotonic: number;
  views: Map<string, View>;
  resumes: Map<string, () => void>;
  pending: Set<Promise<void>>;
  workers: number;
  failures: unknown[];
  stopped: boolean;
}
interface VideoChunk {
  type: "chunk";
  bytes: ArrayBuffer;
  sequence: number;
  start: number;
  end: number;
  mimeType: string;
}
function isVideoChunk(
  item: Record<string, unknown>,
  expectedSequence: number,
): item is Record<string, unknown> & VideoChunk {
  return (
    item.type === "chunk" &&
    item.bytes instanceof ArrayBuffer &&
    item.bytes.byteLength <= 8 * 1024 * 1024 &&
    item.sequence === expectedSequence &&
    typeof item.start === "number" &&
    typeof item.end === "number" &&
    Number.isFinite(item.start) &&
    Number.isFinite(item.end) &&
    item.end >= item.start &&
    typeof item.mimeType === "string"
  );
}

export function createVideoCaptureManager({
  coordinator,
  store,
  onError,
  onStorageError,
}: Options) {
  const active = new Map<string, Active>();
  let workers = 0;
  const sources = new Map<BrowserWindow, WebContents>();
  let videoSession: Electron.Session | undefined;
  const getVideoSession = () => {
    if (videoSession) return videoSession;
    videoSession = session.fromPartition(`paseo-video-${randomUUID()}`);
    videoSession.setDisplayMediaRequestHandler((request, callback) => {
      if (request.videoRequested && !request.audioRequested) {
        for (const [window, target] of sources) {
          if (
            !window.isDestroyed() &&
            request.frame === window.webContents.mainFrame &&
            !target.isDestroyed()
          ) {
            callback({ video: target.mainFrame });
            return;
          }
        }
      }
      callback({});
    });
    return videoSession;
  };
  const report = (member: RecordingMembership, reason: string) => {
    void coordinator
      .reportGap({ recordingId: member.recordingId, memberId: member.memberId, reason })
      .catch(onError);
  };
  const track = (state: Active, work: Promise<void>) => {
    state.pending.add(work);
    void work.then(
      () => state.pending.delete(work),
      (error: unknown) => {
        state.pending.delete(work);
        state.failures.push(error);
        onError(error);
      },
    );
  };
  const begin = (member: RecordingMembership) => {
    const state = active.get(member.recordingId);
    if (!state || state.stopped || state.views.has(member.memberId)) return;
    if (state.workers >= 16 || workers >= 32) {
      report(member, "video-view-limit");
      return;
    }
    const target = webContents.fromId(member.webContentsId);
    if (!target || target.isDestroyed()) {
      report(member, "video-guest-unavailable");
      return;
    }
    const generationId = randomUUID();
    const channel = `paseo-video-${randomUUID()}`;
    const captureSession = getVideoSession();
    const releaseFrames = holdFrameProduction(target);
    state.workers++;
    workers++;
    let win: BrowserWindow | undefined;
    let finish!: () => void;
    let reject!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, rejectPromise) => {
      finish = resolve;
      reject = rejectPromise;
    });
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let stopping = false;
    let forcedRecovery = false;
    let expectedSequence = 0;
    let initialized = false;
    let failureReported = false;
    let generationStart = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const pendingWrites = new Set<Promise<void>>();
    const failedWrites: unknown[] = [];
    const armWatchdog = () => {
      if (stopping) return;
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        report(member, "video-stalled");
        track(
          state,
          Promise.allSettled([stop(true), run]).then(([, outcome]) => {
            if (
              outcome.status === "fulfilled" &&
              !state.stopped &&
              coordinator.getMembership(target.id)?.memberId === member.memberId
            )
              begin(member);
            return undefined;
          }),
        );
      }, 10_000);
    };
    const stop = async (recover = false) => {
      if (stopping) return completed;
      stopping = true;
      if (watchdog) clearTimeout(watchdog);
      if (initialized && win && !win.isDestroyed()) win.webContents.send("paseo-video-stop");
      else finish();
      const timer = setTimeout(() => {
        if (!recover) {
          // Explicit stop or navigation surfaces the timeout as an error.
          // Watchdog recovery records a gap before forcing teardown.
          reject(new Error("Video recorder stop timed out"));
          return;
        }
        try {
          forcedRecovery = true;
          if (win && !win.isDestroyed()) win.destroy();
          finish();
        } catch (error) {
          reject(error);
        }
      }, 10_000);
      try {
        await completed;
      } finally {
        clearTimeout(timer);
      }
    };
    const view: View = { member, target, stop, done: () => run };
    state.views.set(member.memberId, view);
    const navigation = (
      _event: Electron.Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || isInPlace || state.stopped) return;
      target.removeListener("did-start-navigation", navigation);
      report(member, "video-navigation-gap");
      if (state.views.get(member.memberId) === view) state.views.delete(member.memberId);
      track(state, stop());
      const resume = () => {
        target.removeListener("did-stop-loading", resume);
        state.resumes.delete(member.memberId);
        track(
          state,
          run.then(() => {
            if (
              !state.stopped &&
              coordinator.getMembership(target.id)?.memberId === member.memberId
            )
              begin(member);
            return undefined;
          }),
        );
      };
      state.resumes.set(member.memberId, () => target.removeListener("did-stop-loading", resume));
      target.once("did-stop-loading", resume);
    };
    target.on("did-start-navigation", navigation);
    ipcMain.handle(channel, async (event, message: unknown) => {
      if (
        !win ||
        event.sender.id !== win.webContents.id ||
        event.senderFrame !== win.webContents.mainFrame ||
        !message ||
        typeof message !== "object"
      )
        throw new Error("Invalid video sender");
      const item = message as Record<string, unknown>;
      if (item.type === "ready") {
        resolveReady();
        return;
      }
      if (item.type === "started") {
        // Anchor every view to the main-process monotonic clock. Chunk offsets
        // are renderer-monotonic delivery times, not decoded frame timestamps;
        // the startup gap exposes the unknown first-frame latency.
        generationStart = state.baseOffset + performance.now() - state.baseMonotonic;
        report(member, "video-startup-gap");
        armWatchdog();
        return;
      }
      if (item.type === "heartbeat") {
        armWatchdog();
        return;
      }
      if (item.type === "stopped") {
        finish();
        return;
      }
      if (item.type === "error") {
        report(member, "video-capture-interrupted");
        failureReported = true;
        reject(new Error(String(item.message).slice(0, 512)));
        return;
      }
      if (!isVideoChunk(item, expectedSequence)) throw new Error("Invalid video chunk");
      armWatchdog();
      const write = store.writeMediaSegment(member.recordingId, {
        streamId: member.memberId,
        segmentId: randomUUID(),
        generationId,
        sequence: item.sequence as number,
        startMs: Math.max(0, generationStart + item.start),
        durationMs: item.end - item.start,
        mimeType: item.mimeType,
        track: "video",
        bytes: new Uint8Array(item.bytes),
      });
      pendingWrites.add(write);
      try {
        await write;
        expectedSequence++;
      } catch (error) {
        failedWrites.push(error);
        onStorageError?.(member.recordingId, error);
        report(member, "video-storage-failed");
        failureReported = true;
        reject(error);
        throw error;
      } finally {
        pendingWrites.delete(write);
      }
    });
    const run = (async () => {
      try {
        if (stopping) return;
        win = new BrowserWindow({
          show: false,
          webPreferences: {
            session: captureSession,
            preload: join(__dirname, "video-preload.js"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });
        win.webContents.on("will-navigate", (event) => event.preventDefault());
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        sources.set(win, target);
        armWatchdog();
        await Promise.race([win.loadFile(join(__dirname, "recorder.html")), completed]);
        if (stopping) return;
        win.webContents.send("paseo-video-config", { channel });
        await Promise.race([
          ready,
          completed,
          new Promise<never>((_, rejectTimeout) =>
            setTimeout(() => rejectTimeout(new Error("Video renderer did not initialize")), 5000),
          ),
        ]);
        if (stopping) return;
        initialized = true;
        armWatchdog();
        await Promise.race([
          win.webContents.executeJavaScript(
            "window.dispatchEvent(new Event('paseo-video-start'))",
            true,
          ),
          completed,
        ]);
        await completed;
      } catch (error) {
        if (!forcedRecovery) {
          if (!stopping && !failureReported) report(member, "video-capture-unavailable");
          throw error;
        }
      } finally {
        if (watchdog) clearTimeout(watchdog);
        releaseFrames();
        target.removeListener("did-start-navigation", navigation);
        ipcMain.removeHandler(channel);
        if (win) sources.delete(win);
        if (win && !win.isDestroyed()) win.destroy();
        await Promise.allSettled(pendingWrites);
        state.workers--;
        workers--;
        if (state.views.get(member.memberId) === view) state.views.delete(member.memberId);
        finish();
      }
      if (forcedRecovery && failedWrites.length)
        throw new AggregateError(failedWrites, "Video writes failed during recovery");
    })();
    track(state, run);
  };
  const unsubscribe = coordinator.subscribe((change) => {
    const state = active.get(change.member.recordingId);
    if (!state || state.stopped) return;
    state.resumes.get(change.member.memberId)?.();
    state.resumes.delete(change.member.memberId);
    if (change.type === "replaced") report(change.member, "video-guest-replaced");
    if (change.type !== "added") {
      const old = state.views.get(change.member.memberId);
      if (old) {
        state.views.delete(change.member.memberId);
        track(
          state,
          Promise.allSettled([old.stop(), old.done()]).then(([, outcome]) => {
            if (
              change.type === "replaced" &&
              outcome.status === "fulfilled" &&
              !state.stopped &&
              coordinator.getMembership(change.member.webContentsId)?.memberId ===
                change.member.memberId
            )
              begin(change.member);
            return undefined;
          }),
        );
        return;
      }
    }
    if (change.type !== "removed") begin(change.member);
  });
  const stop = async (recordingId: string) => {
    const state = active.get(recordingId);
    if (!state) return;
    state.stopped = true;
    for (const cancel of state.resumes.values()) cancel();
    state.resumes.clear();
    const results = await Promise.allSettled(
      Array.from(state.views.values(), (view) => view.stop()),
    );
    while (state.pending.size)
      results.push(...(await Promise.allSettled(Array.from(state.pending))));
    active.delete(recordingId);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length || state.failures.length)
      throw new AggregateError(
        [...state.failures, ...failures.map((failure) => failure.reason)],
        "Video capture failed",
      );
  };
  const unsubscribeStop = coordinator.subscribeStop(stop);
  return {
    async start(recordingId: string) {
      if (active.has(recordingId)) throw new Error("Video capture is already active");
      const metadata = await store.readMetadata(recordingId);
      const members = coordinator.listMemberships(recordingId);
      if (!members.length) throw new Error("Recording has no live members");
      active.set(recordingId, {
        baseOffset: Math.max(0, Date.now() - metadata.startedAt),
        baseMonotonic: performance.now(),
        views: new Map(),
        resumes: new Map(),
        pending: new Set(),
        workers: 0,
        failures: [],
        stopped: false,
      });
      for (const member of members) begin(member);
    },
    stop,
    async dispose() {
      unsubscribe();
      unsubscribeStop();
      const outcomes = await Promise.allSettled(Array.from(active.keys(), stop));
      videoSession?.setDisplayMediaRequestHandler(null);
      const failures = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Video cleanup failed",
        );
    },
  };
}
