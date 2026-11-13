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
  failDestroyOnce: false,
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
      if (mock.failDestroyOnce) {
        mock.failDestroyOnce = false;
        throw new Error("destroy failed");
      }
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
import type { BrowserRecordingCoordinator, RecordingMembership } from "./coordinator.js";
import type { BrowserRecordingStore } from "./store.js";

describe("video teardown failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mock.handlers.clear();
    mock.windows.length = 0;
    mock.firstNeverStarts = false;
    mock.firstNeverLoads = false;
    mock.failDestroyOnce = false;
    const target = new EventEmitter();
    target.setMaxListeners(0);
    mock.target = Object.assign(target, {
      id: 101,
      mainFrame: {},
      isDestroyed: () => false,
      getBackgroundThrottling: () => true,
      setBackgroundThrottling: () => {},
    });
  });
  afterEach(() => vi.useRealTimers());
  it("surfaces a failed watchdog destroy and does not start a replacement", async () => {
    const member: RecordingMembership = {
      recordingId: "recording",
      memberId: "member",
      parentMemberId: null,
      browserId: "root",
      webContentsId: 101,
      hostWebContentsId: 10,
      workspaceId: "workspace",
    };
    const errors: unknown[] = [];
    const coordinator = {
      listMemberships: () => [member],
      getMembership: () => member,
      subscribe: () => () => {},
      subscribeStop: () => () => {},
      reportGap: async () => true,
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
    await vi.advanceTimersByTimeAsync(10_100);
    mock.failDestroyOnce = true;
    await vi.advanceTimersByTimeAsync(10_100);
    expect(mock.windows).toHaveLength(1);
    expect(errors.some((error) => String(error).includes("destroy failed"))).toBe(true);
    await expect(manager.stop("recording")).rejects.toThrow();
    await manager.dispose();
  });
  it("reports an explicit stop timeout when the recorder ignores stop", async () => {
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
    const store = {
      readMetadata: async () => ({ startedAt: Date.now() }),
    } as unknown as BrowserRecordingStore;
    const manager = createVideoCaptureManager({ coordinator, store, onError: () => {} });
    await manager.start("recording");
    await vi.advanceTimersByTimeAsync(0);
    const stopped = manager.stop("recording");
    const assertion = expect(stopped).rejects.toThrow("Video capture failed");
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    await manager.dispose();
  });

  it("does not duplicate a recorder when navigation occurs during watchdog recovery", async () => {
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
    const manager = createVideoCaptureManager({ coordinator, store, onError: () => {} });
    await manager.start("recording");
    await vi.advanceTimersByTimeAsync(10_100);
    (mock.target as EventEmitter).emit(
      "did-start-navigation",
      {},
      "https://fixture.test/next",
      false,
      true,
    );
    (mock.target as EventEmitter).emit("did-stop-loading");
    await vi.advanceTimersByTimeAsync(10_100);
    expect(mock.windows).toHaveLength(2);
    expect(gaps).toContain("video-navigation-gap");
    await manager.stop("recording");
    await manager.dispose();
  });

  it("reports per-recording and global video worker limits", async () => {
    const members = (recordingId: string, count: number): RecordingMembership[] =>
      Array.from({ length: count }, (_, index) => ({
        recordingId,
        memberId: `${recordingId}-${index}`,
        parentMemberId: null,
        browserId: `browser-${index}`,
        webContentsId: 101 + index,
        hostWebContentsId: 10,
        workspaceId: "workspace",
      }));
    const gaps: string[] = [];
    const coordinator = {
      listMemberships: (id: string) => {
        if (id === "first") return members(id, 17);
        if (id === "second") return members(id, 16);
        return members(id, 1);
      },
      getMembership: () => null,
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
    const manager = createVideoCaptureManager({ coordinator, store, onError: () => {} });
    await manager.start("first");
    await manager.start("second");
    await manager.start("third");
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.windows).toHaveLength(32);
    expect(gaps.filter((reason) => reason === "video-view-limit")).toHaveLength(2);
    await manager.stop("first");
    await manager.stop("second");
    await manager.stop("third");
    await manager.dispose();
  });
});
