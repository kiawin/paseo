// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
vi.mock("./player", () => ({ RecordingPlayer: () => null }));
const malicious = '<img src=x onerror="alert(1)">';
let legacyEvent = false;
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
      readEvents: async () => ({
        events: [
          {
            kind: "network",
            memberId: "tab",
            ...(legacyEvent ? {} : { timelineMs: 100 }),
            payload: {
              request: {
                method: "GET",
                url: malicious,
                body: { state: "complete", data: malicious },
              },
              response: { status: 200, body: { state: "complete", data: malicious } },
            },
          },
        ],
        nextCursor: null,
        incompleteTail: false,
      }),
      listMedia: async () => ({ segments: [], incomplete: [], nextCursor: null, pending: false }),
      delete: async () => {},
    },
  }),
}));
afterEach(() => {
  cleanup();
  legacyEvent = false;
});
describe("recording inspection rendering", () => {
  it("explains when an older event has no timeline time", async () => {
    legacyEvent = true;
    const { RecordingsPane } = await import("./pane");
    render(<RecordingsPane workspaceId="w" />);
    fireEvent.click(await screen.findByText("Fixture"));
    fireEvent.click(await screen.findByText(/GET.*<img/));
    expect(screen.getByText("panels.recordings.eventUntimed")).toBeTruthy();
  });
  it("renders captured markup as inert text in the event summary and details", async () => {
    const { RecordingsPane } = await import("./pane");
    const { container } = render(<RecordingsPane workspaceId="w" />);
    fireEvent.click(await screen.findByText("Fixture"));
    await waitFor(() => expect(screen.getByText(/GET.*<img/)).toBeTruthy());
    fireEvent.click(screen.getByText(/GET.*<img/));
    await waitFor(() => expect(container.textContent).toContain(malicious));
    expect(container.querySelector("img")).toBeNull();
  });
});
