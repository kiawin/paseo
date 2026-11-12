// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  ScrollView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (fn: (theme: unknown) => unknown) =>
      fn({
        colors: {
          foreground: "black",
          foregroundMuted: "gray",
          surface0: "white",
          destructive: "red",
          border: "gray",
        },
      }),
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/press-highlight", () => ({
  PressHighlight: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: async () => true }));
vi.mock("./share", () => ({ RecordingShare: () => null }));
vi.mock("./player", () => ({
  RecordingPlayer: ({ hasMore }: { hasMore: boolean }) => (
    <span>{hasMore ? "loading video" : "video ready"}</span>
  ),
}));
const listMedia = vi.hoisted(() => vi.fn());
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    recording: {
      list: async () => ({
        recordings: [
          {
            recordingId: "r",
            workspaceId: "w",
            startedAt: 1,
            status: "complete",
            title: "Fixture",
          },
        ],
        incomplete: [],
      }),
      readEvents: async () => ({ events: [], nextCursor: null, incompleteTail: false }),
      listMedia,
      delete: async () => {},
    },
  }),
}));
afterEach(() => {
  cleanup();
  listMedia.mockReset();
});
it("automatically loads subsequent media pages so playback becomes available", async () => {
  listMedia.mockImplementation(async ({ cursor }: { cursor: string | null }) => ({
    segments: [],
    incomplete: [],
    nextCursor: cursor === null ? "page-2" : null,
    pending: false,
  }));
  const { RecordingsPane } = await import("./pane");
  render(<RecordingsPane workspaceId="w" />);
  fireEvent.click(await screen.findByText("Fixture"));
  await waitFor(() => expect(listMedia).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("video ready")).toBeTruthy();
});
