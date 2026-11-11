// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
const calls = vi.hoisted(() => ({ mimes: [] as string[], appends: 0 }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (fn: (theme: unknown) => unknown) =>
      fn({ colors: { foregroundMuted: "gray", destructive: "red" } }),
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    recording: {
      readMedia: async ({ offset, length }: { offset: number; length: number }) => ({
        bytes: new TextEncoder().encode("abc").slice(offset, offset + length),
        totalBytes: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      }),
    },
  }),
}));
class FakeBuffer extends EventTarget {
  buffered = { length: 1, start: () => 0, end: () => 10 };
  appendBuffer() {
    calls.appends++;
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
  remove() {
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
}
class FakeMediaSource extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  readyState = "open";
  constructor() {
    super();
    setTimeout(() => this.dispatchEvent(new Event("sourceopen")), 0);
  }
  addSourceBuffer(mime: string) {
    calls.mimes.push(mime);
    return new FakeBuffer();
  }
  endOfStream() {}
}
const segments = [
  {
    streamId: "tab",
    segmentId: "audio",
    generationId: "first",
    sequence: 0,
    startMs: 0,
    durationMs: 1000,
    mimeType: "video/webm;codecs=vp8,opus",
    track: "combined" as const,
  },
  {
    streamId: "tab",
    segmentId: "video",
    generationId: "second",
    sequence: 0,
    startMs: 1000,
    durationMs: 1000,
    mimeType: "video/webm;codecs=vp8",
    track: "video" as const,
  },
];
const firstSeek = { streamId: "tab", timeMs: 500, nonce: 1 };
const secondSeek = { streamId: "tab", timeMs: 1500, nonce: 2 };
afterEach(() => {
  cleanup();
  calls.mimes.length = 0;
  calls.appends = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("loads combined media and switches to a video-only generation", async () => {
  vi.stubGlobal("MediaSource", FakeMediaSource);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:test";
      }
      static revokeObjectURL() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const { RecordingPlayer } = await import("./player.electron");
  const view = render(
    <RecordingPlayer recordingId="r" segments={segments} hasMore={false} seek={firstSeek} />,
  );
  await waitFor(() => expect(calls.mimes).toContain("video/webm;codecs=vp8,opus"));
  await waitFor(() => expect(calls.appends).toBeGreaterThan(0));
  view.rerender(
    <RecordingPlayer recordingId="r" segments={segments} hasMore={false} seek={secondSeek} />,
  );
  await waitFor(() => expect(calls.mimes).toContain("video/webm;codecs=vp8"));
  await waitFor(() => expect(calls.appends).toBeGreaterThan(1));
});
