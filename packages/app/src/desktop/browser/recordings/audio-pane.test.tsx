// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
vi.mock("./player", () => ({ RecordingPlayer: () => null }));
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
            audioRequested: true,
            audioStatus: "unavailable",
            audioReason: "denied",
          },
        ],
        incomplete: [],
      }),
      readEvents: async () => ({ events: [], nextCursor: null, incompleteTail: false }),
      listMedia: async () => ({ segments: [], incomplete: [], nextCursor: null, pending: false }),
      delete: async () => {},
    },
  }),
}));
afterEach(cleanup);
describe("saved recording audio", () => {
  it("shows when requested audio was unavailable after reopening a recording", async () => {
    const { RecordingsPane } = await import("./pane");
    render(<RecordingsPane workspaceId="w" />);
    fireEvent.click(await screen.findByText("Fixture"));
    expect(await screen.findByText("workspace.browser.controls.audioUnavailable")).toBeTruthy();
  });
});
