import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

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
const fake = vi.hoisted(() => ({
  handlers: new Map<string, FakeHandler>(),
  windows: [] as Array<{ destroyed: boolean; webContents: FakeContents }>,
  target: null as unknown,
}));
vi.mock("electron", () => {
  class Window {
    destroyed = false;
    webContents: FakeContents;
    constructor() {
      const contents = Object.assign(new EventEmitter(), {
        id: 200,
        mainFrame: {},
        channel: "",
        setWindowOpenHandler: () => {},
        send: (channel: string, value?: { channel: string }) => {
          if (channel === "paseo-video-config") {
            contents.channel = value!.channel;
            void fake.handlers.get(contents.channel)!(
              { sender: contents, senderFrame: contents.mainFrame },
              { type: "ready" },
            );
          }
          if (channel === "paseo-video-stop")
            void fake.handlers.get(contents.channel)!(
              { sender: contents, senderFrame: contents.mainFrame },
              { type: "stopped" },
            );
        },
        executeJavaScript: async () => {
          await fake.handlers.get(contents.channel)!(
            { sender: contents, senderFrame: contents.mainFrame },
            { type: "started" },
          );
        },
      });
      this.webContents = contents;
      fake.windows.push(this);
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
    BrowserWindow: Window,
    ipcMain: {
      handle: (name: string, handler: FakeHandler) => fake.handlers.set(name, handler),
      removeHandler: (name: string) => fake.handlers.delete(name),
    },
    session: { fromPartition: () => ({ setDisplayMediaRequestHandler: () => {} }) },
    webContents: { fromId: () => fake.target },
  };
});
describe("audio capture guard", () => {
  it("rejects a private recorder claiming audio when audio was not requested", async () => {
    fake.handlers.clear();
    fake.windows.length = 0;
    fake.target = Object.assign(new EventEmitter(), {
      id: 101,
      mainFrame: {},
      isDestroyed: () => false,
      getBackgroundThrottling: () => true,
      setBackgroundThrottling: () => {},
    });
    const member = {
      recordingId: "r",
      memberId: "m",
      parentMemberId: null,
      browserId: "root",
      webContentsId: 101,
      hostWebContentsId: 10,
      workspaceId: "w",
    };
    const coordinator = {
      listMemberships: () => [member],
      getMembership: () => member,
      subscribe: () => () => {},
      subscribeStop: () => () => {},
      reportGap: async () => true,
    };
    const { createVideoCaptureManager } = await import("./video-capture.js");
    const manager = createVideoCaptureManager({
      coordinator: coordinator as never,
      store: { readMetadata: async () => ({ startedAt: Date.now() }) } as never,
      onError: () => {},
    });
    await manager.start("r");
    await vi.waitFor(() => expect(fake.windows.length).toBe(1));
    const contents = fake.windows[0].webContents;
    await vi.waitFor(() => expect(contents.channel).toBeTruthy());
    const handler = fake.handlers.get(contents.channel)!;
    await expect(
      handler(
        { sender: contents, senderFrame: contents.mainFrame },
        { type: "audio-status", status: "captured" },
      ),
    ).rejects.toThrow("Unexpected audio status");
    await manager.stop("r");
    await manager.dispose();
  });
});
