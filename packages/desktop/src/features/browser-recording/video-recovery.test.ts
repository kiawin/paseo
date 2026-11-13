import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeContents extends EventEmitter {
  id: number;
  mainFrame: object;
  channel: string;
  setWindowOpenHandler: () => void;
  send: (channel: string, value?: { channel: string }) => void;
  executeJavaScript: () => Promise<void>;
}
type FakeHandler = (
  event: { sender: FakeContents; senderFrame: object },
  message: { type: string; [key: string]: unknown },
) => Promise<void>;
const mock = vi.hoisted(() => ({
  handlers: new Map<string, FakeHandler>(),
  windows: [] as { destroyed: boolean; webContents: FakeContents }[],
  target: undefined as unknown,
  firstNeverStarts: false,
  firstNeverLoads: false,
}));
vi.mock("electron", () => {
  let nextId = 200;
  class FakeWindow {
    destroyed = false;
    webContents: FakeContents;
    constructor() {
      const emitter = new EventEmitter();
      const contents = Object.assign(emitter, {
        id: nextId++,
        mainFrame: {},
        channel: "",
        setWindowOpenHandler: () => {},
        send: (channel: string, value?: { channel: string }) => {
          if (channel === "paseo-video-config") {
            contents.channel = value!.channel;
            void mock.handlers.get(value!.channel)!(
              { sender: contents, senderFrame: contents.mainFrame },
              { type: "ready" },
            );
          } else if (channel === "paseo-video-stop" && mock.windows.length > 1) {
            void mock.handlers.get(contents.channel)!(
              { sender: contents, senderFrame: contents.mainFrame },
              { type: "stopped" },
            );
          }
        },
        executeJavaScript: async () => {
          if (mock.firstNeverStarts && mock.windows.length === 1)
            return new Promise<void>(() => {});
          await mock.handlers.get(contents.channel)!(
            { sender: contents, senderFrame: contents.mainFrame },
            { type: "started" },
          );
        },
      });
      this.webContents = contents;
      mock.windows.push(this);
    }
    async loadFile() {
      if (mock.firstNeverLoads && mock.windows.length === 1) return new Promise<void>(() => {});
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (name: string, fn: FakeHandler) => mock.handlers.set(name, fn),
      removeHandler: (name: string) => mock.handlers.delete(name),
    },
    session: { fromPartition: () => ({ setDisplayMediaRequestHandler: () => {} }) },
    webContents: { fromId: () => mock.target },
  };
});

import { createVideoCaptureManager } from "./video-capture.js";
import type {
  BrowserRecordingCoordinator,
  RecordingMembership,
  RecordingMembershipChange,
} from "./coordinator.js";
import type { BrowserRecordingStore } from "./store.js";

describe("video watchdog recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mock.handlers.clear();
    mock.windows.length = 0;
    mock.firstNeverStarts = false;
    mock.firstNeverLoads = false;
    mock.target = Object.assign(new EventEmitter(), {
      id: 101,
      mainFrame: {},
      isDestroyed: () => false,
      getBackgroundThrottling: () => true,
      setBackgroundThrottling: () => {},
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { startupStalled: false, stopDuringRecovery: false, loadStalled: false },
    { startupStalled: true, stopDuringRecovery: false, loadStalled: false },
    { startupStalled: false, stopDuringRecovery: true, loadStalled: false },
    { startupStalled: false, stopDuringRecovery: false, loadStalled: true },
  ])(
    "recovers a hung recorder (startup stalled: $startupStalled, stop during recovery: $stopDuringRecovery, load stalled: $loadStalled)",
    async ({ startupStalled, stopDuringRecovery, loadStalled }) => {
      mock.firstNeverStarts = startupStalled;
      mock.firstNeverLoads = loadStalled;
      const member: RecordingMembership = {
        recordingId: "recording",
        memberId: "member",
        parentMemberId: null,
        browserId: "root",
        webContentsId: 101,
        hostWebContentsId: 10,
        workspaceId: "workspace",
      };
      const gaps: string[] = [];
      const errors: unknown[] = [];
      const coordinator = {
        listMemberships: () => [member],
        getMembership: () => member,
        subscribe: () => () => {},
        subscribeStop: () => () => {},
        reportGap: async ({ reason }: { reason: string }) => {
          gaps.push(reason);
          return true;
        },
      } as unknown as BrowserRecordingCoordinator;
      const store = {
        readMetadata: async () => ({ startedAt: Date.now() }),
      } as unknown as BrowserRecordingStore;
      const manager = createVideoCaptureManager({
        coordinator,
        store,
        onError: (error) => errors.push(error),
      });
      await manager.start("recording");
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.windows).toHaveLength(1);
      if (stopDuringRecovery) {
        await vi.advanceTimersByTimeAsync(10_100);
        const stopped = manager.stop("recording");
        await vi.advanceTimersByTimeAsync(10_000);
        await stopped;
      } else {
        await vi.advanceTimersByTimeAsync(loadStalled ? 10_100 : 20_100);
      }
      expect(mock.windows[0].destroyed).toBe(true);
      expect(mock.windows).toHaveLength(stopDuringRecovery ? 1 : 2);
      expect(gaps).toContain("video-stalled");
      expect(gaps.filter((gap) => gap === "video-startup-gap")).toHaveLength(
        stopDuringRecovery || startupStalled || loadStalled ? 1 : 2,
      );
      expect(errors).toEqual([]);
      if (!stopDuringRecovery) await manager.stop("recording");
      await manager.dispose();
    },
  );

  it.each([false, true])(
    "drains an in-flight segment before replacement (write fails: %s)",
    async (writeFails) => {
      const member: RecordingMembership = {
        recordingId: "recording",
        memberId: "member",
        parentMemberId: null,
        browserId: "root",
        webContentsId: 101,
        hostWebContentsId: 10,
        workspaceId: "workspace",
      };
      const coordinator = {
        listMemberships: () => [member],
        getMembership: () => member,
        subscribe: () => () => {},
        subscribeStop: () => () => {},
        reportGap: async () => true,
      } as unknown as BrowserRecordingCoordinator;
      let finishWrite!: () => void;
      let failWrite!: (error: Error) => void;
      const pendingWrite = new Promise<void>((resolve, reject) => {
        finishWrite = resolve;
        failWrite = reject;
      });
      const store = {
        readMetadata: async () => ({ startedAt: Date.now() }),
        writeMediaSegment: () => pendingWrite,
      } as unknown as BrowserRecordingStore;
      const errors: unknown[] = [];
      const manager = createVideoCaptureManager({
        coordinator,
        store,
        onError: (error) => errors.push(error),
      });
      await manager.start("recording");
      await vi.advanceTimersByTimeAsync(0);
      const contents = mock.windows[0].webContents;
      const write = mock.handlers.get(contents.channel)!(
        { sender: contents, senderFrame: contents.mainFrame },
        {
          type: "chunk",
          bytes: new ArrayBuffer(4),
          sequence: 0,
          start: 0,
          end: 1,
          mimeType: "video/webm",
        },
      );
      const outcome = write.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(20_100);
      expect(mock.windows).toHaveLength(1);
      if (writeFails) failWrite(new Error("synthetic disk failure"));
      else finishWrite();
      const error = await outcome;
      await vi.advanceTimersByTimeAsync(0);
      if (writeFails) {
        expect(error).toBeInstanceOf(Error);
        expect(errors).toHaveLength(1);
        expect(mock.windows).toHaveLength(1);
        await expect(manager.stop("recording")).rejects.toThrow("Video capture failed");
      } else {
        expect(error).toBeNull();
        expect(errors).toEqual([]);
        expect(mock.windows).toHaveLength(2);
        await manager.stop("recording");
      }
      await manager.dispose();
    },
  );

  it("does not start duplicate workers when membership changes during forced recovery", async () => {
    const member: RecordingMembership = {
      recordingId: "recording",
      memberId: "member",
      parentMemberId: null,
      browserId: "root",
      webContentsId: 101,
      hostWebContentsId: 10,
      workspaceId: "workspace",
    };
    let listener!: (change: RecordingMembershipChange) => void;
    const coordinator = {
      listMemberships: () => [member],
      getMembership: () => member,
      subscribe: (callback: (change: RecordingMembershipChange) => void) => {
        listener = callback;
        return () => {};
      },
      subscribeStop: () => () => {},
      reportGap: async () => true,
    } as unknown as BrowserRecordingCoordinator;
    const store = {
      readMetadata: async () => ({ startedAt: Date.now() }),
    } as unknown as BrowserRecordingStore;
    const errors: unknown[] = [];
    const manager = createVideoCaptureManager({
      coordinator,
      store,
      onError: (error) => errors.push(error),
    });
    await manager.start("recording");
    await vi.advanceTimersByTimeAsync(10_100);
    listener({ type: "replaced", member, previousWebContentsId: 99 });
    expect(mock.windows).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.windows).toHaveLength(2);
    expect(errors).toEqual([]);
    await manager.stop("recording");
    await manager.dispose();
  });
});
