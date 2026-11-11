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
  message: { type: string },
) => Promise<void>;
const mock = vi.hoisted(() => ({
  handlers: new Map<string, FakeHandler>(),
  windows: [] as { destroyed: boolean }[],
  target: undefined as unknown,
  firstNeverStarts: false,
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
          if (mock.firstNeverStarts && mock.windows.length === 1) return;
          await mock.handlers.get(contents.channel)!(
            { sender: contents, senderFrame: contents.mainFrame },
            { type: "started" },
          );
        },
      });
      this.webContents = contents;
      mock.windows.push(this);
    }
    async loadFile() {}
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
import type { BrowserRecordingCoordinator, RecordingMembership } from "./coordinator.js";
import type { BrowserRecordingStore } from "./store.js";

describe("video watchdog recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mock.handlers.clear();
    mock.windows.length = 0;
    mock.firstNeverStarts = false;
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

  it.each([false, true])(
    "destroys a recorder that ignores stop and resumes the same member (startup stalled: %s)",
    async (startupStalled) => {
      mock.firstNeverStarts = startupStalled;
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
      await vi.advanceTimersByTimeAsync(20_100);
      expect(mock.windows[0].destroyed).toBe(true);
      expect(mock.windows).toHaveLength(2);
      expect(gaps).toContain("video-stalled");
      expect(errors).toEqual([]);
      await manager.stop("recording");
      await manager.dispose();
    },
  );
});
