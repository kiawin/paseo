// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
const bytes = new TextEncoder().encode("abc");
const eventSeek = { streamId: "tab", timeMs: 500, nonce: 1 };
let corruptMedia = false;
const gapSegments = [
  {
    streamId: "tab",
    segmentId: "a",
    generationId: "g1",
    sequence: 0,
    startMs: 100,
    durationMs: 1000,
    mimeType: "video/webm",
  },
  {
    streamId: "tab",
    segmentId: "b",
    generationId: "g2",
    sequence: 0,
    startMs: 1200,
    durationMs: 1000,
    mimeType: "video/webm",
  },
];
const audioSegments = [
  {
    streamId: "tab",
    segmentId: "a",
    generationId: "g1",
    sequence: 0,
    startMs: 100,
    durationMs: 1000,
    mimeType: "video/webm",
    track: "combined" as const,
  },
];
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    recording: {
      readMedia: async ({ offset, length }: { offset: number; length: number }) => ({
        bytes: bytes.slice(offset, offset + length),
        totalBytes: 3,
        sha256: corruptMedia
          ? "0".repeat(64)
          : "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      }),
    },
  }),
}));

class FakeBuffer extends EventTarget {
  buffered = { length: 1, start: () => 0, end: () => 10 };
  appendBuffer() {
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
  addSourceBuffer() {
    return new FakeBuffer();
  }
  endOfStream() {}
}
afterEach(() => {
  cleanup();
  corruptMedia = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("recording player presentation", () => {
  it("allows recorded audio to be muted and unmuted", async () => {
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
    const { container } = render(
      <RecordingPlayer recordingId="r" segments={audioSegments} hasMore={false} seek={eventSeek} />,
    );
    const video = container.querySelector("video")!;
    fireEvent.click(screen.getByText("panels.recordings.muteAudio"));
    expect(video.muted).toBe(true);
    fireEvent.click(screen.getByText("panels.recordings.unmuteAudio"));
    expect(video.muted).toBe(false);
  });
  it("can play through a gap after an integrity error", async () => {
    corruptMedia = true;
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
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { RecordingPlayer } = await import("./player.electron");
    render(
      <RecordingPlayer recordingId="r" segments={gapSegments} hasMore={false} seek={eventSeek} />,
    );
    await screen.findByText(/integrity check failed/i);
    const slider = screen.getByRole("slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "1150" } });
    fireEvent.click(screen.getByText("panels.recordings.play"));
    await waitFor(() => expect(Number(slider.value)).toBeGreaterThanOrEqual(1200));
  });
  it("marks a gap and advances its shared clock into the next generation", async () => {
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
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { RecordingPlayer } = await import("./player.electron");
    render(
      <RecordingPlayer recordingId="r" segments={gapSegments} hasMore={false} seek={eventSeek} />,
    );
    const slider = screen.getByRole("slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "1150" } });
    expect(screen.getByText("panels.recordings.videoGap")).toBeTruthy();
    fireEvent.click(screen.getByText("panels.recordings.play"));
    await waitFor(() => expect(Number(slider.value)).toBeGreaterThanOrEqual(1200));
    await waitFor(() => expect(screen.queryByText("panels.recordings.videoGap")).toBeNull());
  });
  it("loads a verified generation and seeks the video to a selected event", async () => {
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
    const { container } = render(
      <RecordingPlayer
        recordingId="r"
        segments={[
          {
            streamId: "tab",
            segmentId: "s",
            generationId: "g",
            sequence: 0,
            startMs: 100,
            durationMs: 1000,
            mimeType: "video/webm",
          },
        ]}
        hasMore={false}
        seek={eventSeek}
      />,
    );
    await waitFor(() => expect(container.querySelector("video")?.currentTime).toBeCloseTo(0.4));
  });
});
