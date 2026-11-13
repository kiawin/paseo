// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
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
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    recording: {
      readMedia: async () => ({
        bytes: new TextEncoder().encode("abc"),
        totalBytes: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      }),
    },
  }),
}));
const removals: number[] = [];
let quotaSeconds = Infinity;
const eventSeek = { streamId: "tab", timeMs: 40000, nonce: 1 };
class FakeBuffer extends EventTarget {
  end = 0;
  start = 0;
  buffered = { length: 1, start: () => this.start, end: () => this.end };
  appendBuffer() {
    if (this.end - this.start >= quotaSeconds)
      throw new DOMException("media buffer full", "QuotaExceededError");
    this.end += 1;
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
  remove(_start: number, end: number) {
    removals.push(this.end);
    this.start = end;
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
  addSourceBuffer() {
    return new FakeBuffer();
  }
  endOfStream() {}
}
afterEach(() => {
  cleanup();
  removals.length = 0;
  quotaSeconds = Infinity;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("recovers from buffer quota while seeking beyond the available buffer", async () => {
  quotaSeconds = 20;
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
  const segments = Array.from({ length: 45 }, (_, sequence) => ({
    streamId: "tab",
    segmentId: `s${sequence}`,
    generationId: "g",
    sequence,
    startMs: sequence * 1000,
    durationMs: 1000,
    mimeType: "video/webm",
  }));
  const { container } = render(
    <RecordingPlayer recordingId="r" segments={segments} hasMore={false} seek={eventSeek} />,
  );
  await waitFor(() => expect(container.querySelector("video")?.currentTime).toBe(40));
  expect(removals.some((end) => end < 40)).toBe(true);
});
it("keeps earlier video buffered until a distant seek has reached its target", async () => {
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
  const segments = Array.from({ length: 45 }, (_, sequence) => ({
    streamId: "tab",
    segmentId: `s${sequence}`,
    generationId: "g",
    sequence,
    startMs: sequence * 1000,
    durationMs: 1000,
    mimeType: "video/webm",
  }));
  const { container } = render(
    <RecordingPlayer recordingId="r" segments={segments} hasMore={false} seek={eventSeek} />,
  );
  await waitFor(() => expect(container.querySelector("video")?.currentTime).toBe(40));
  expect(removals.every((end) => end >= 40)).toBe(true);
});
