// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ on: vi.fn(), invoke: vi.fn(async () => {}) }));
vi.mock("electron", () => ({ ipcRenderer: ipc }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  ipc.on.mockClear();
  ipc.invoke.mockReset();
});
describe("audio permission fallback", () => {
  it("drains an audio-ended status after queued chunks and before stop completes", async () => {
    const audioTrack = new EventTarget();
    const videoTrack = new EventTarget();
    const stream = {
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [videoTrack],
      getTracks: () => [],
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ipc.invoke.mockImplementation(async (_channel, message: { type?: string }) => {
      if (message.type === "chunk") await gate;
    });
    class FakeRecorder {
      static instance: FakeRecorder;
      state = "inactive";
      mimeType = "video/webm";
      ondataavailable: ((event: unknown) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        FakeRecorder.instance = this;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    await import("./video-preload.js");
    const configure = ipc.on.mock.calls.find(
      ([channel]) => channel === "paseo-video-config",
    )?.[1] as (event: unknown, config: unknown) => void;
    configure({}, { channel: "fixture", audio: true });
    window.dispatchEvent(new Event("paseo-video-start"));
    await vi.waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith(
        "fixture",
        expect.objectContaining({ type: "started" }),
      ),
    );
    FakeRecorder.instance.ondataavailable?.({
      data: { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
    });
    await vi.waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith(
        "fixture",
        expect.objectContaining({ type: "chunk" }),
      ),
    );
    audioTrack.dispatchEvent(new Event("ended"));
    const stop = ipc.on.mock.calls.find(
      ([channel]) => channel === "paseo-video-stop",
    )?.[1] as () => void;
    stop();
    expect(ipc.invoke.mock.calls.some(([, item]) => item.type === "stopped")).toBe(false);
    release();
    await vi.waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith(
        "fixture",
        expect.objectContaining({ type: "stopped" }),
      ),
    );
    const types = ipc.invoke.mock.calls.map(([, item]) =>
      item.type === "audio-status" && item.reason === "ended" ? "audio-ended" : item.type,
    );
    expect(types.indexOf("chunk")).toBeLessThan(types.indexOf("audio-ended"));
    expect(types.indexOf("audio-ended")).toBeLessThan(types.indexOf("stopped"));
  });
  it("reports denied audio and retries video-only after NotAllowedError", async () => {
    const videoTrack = { addEventListener: vi.fn(), stop: vi.fn() };
    const stream = {
      getAudioTracks: () => [],
      getVideoTracks: () => [videoTrack],
      getTracks: () => [videoTrack],
    };
    const getDisplayMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockResolvedValueOnce(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    });
    class FakeRecorder {
      state = "inactive";
      mimeType = "video/webm";
      ondataavailable: ((event: unknown) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    await import("./video-preload.js");
    const configure = ipc.on.mock.calls.find(
      ([channel]) => channel === "paseo-video-config",
    )?.[1] as (event: unknown, config: unknown) => void;
    configure({}, { channel: "fixture", audio: true });
    window.dispatchEvent(new Event("paseo-video-start"));
    await vi.waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith(
        "fixture",
        expect.objectContaining({ type: "audio-status", status: "unavailable", reason: "denied" }),
      ),
    );
    expect(getDisplayMedia).toHaveBeenNthCalledWith(1, { video: true, audio: true });
    expect(getDisplayMedia).toHaveBeenNthCalledWith(2, { video: true, audio: false });
  });
});
