// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const calls = vi.hoisted(() => ({
  list: vi.fn(),
  change: vi.fn(),
  confirm: vi.fn(),
  transfer: vi.fn(),
  forgetCorrupt: vi.fn(),
}));
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
      listShareAudit: calls.list,
      changeShareAudit: calls.change,
      forgetCorruptShareAudit: calls.forgetCorrupt,
    },
  }),
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: calls.confirm }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ sessions: {} }),
    { getState: () => ({ sessions: {} }) },
  ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const recording = {
  recordingId: "rec",
  workspaceId: "ws",
  startedAt: 1,
  status: "complete" as const,
};
it("does not transfer on mount and makes forgetting an orphaned copy explicit", async () => {
  const entry = {
    recordingId: "rec",
    serverId: "remote",
    agentId: "agent",
    shareId: "01900000-0000-4000-8000-000000000000",
    time: 1,
    completeness: { complete: false, reasons: ["gap"] },
    manifestPath: "",
  };
  calls.list.mockResolvedValue([entry]);
  calls.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  calls.change.mockResolvedValue(undefined);
  const { RecordingShare } = await import("./share");
  render(<RecordingShare recording={recording} />);
  expect(await screen.findByText("panels.recordings.sharePending")).toBeTruthy();
  expect(calls.change).not.toHaveBeenCalled();
  expect(calls.transfer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("panels.recordings.forgetCopy"));
  await waitFor(() => expect(calls.confirm).toHaveBeenCalledTimes(1));
  expect(calls.change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("panels.recordings.forgetCopy"));
  await waitFor(() =>
    expect(calls.change).toHaveBeenCalledWith({ recordingId: "rec", removeShareId: entry.shareId }),
  );
  expect(calls.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ destructive: true, message: "panels.recordings.forgetCopyMessage" }),
  );
});

it("asks before forgetting damaged share history", async () => {
  calls.list.mockRejectedValueOnce(new Error("damaged"));
  calls.list.mockResolvedValue([]);
  calls.confirm.mockResolvedValueOnce(true);
  calls.forgetCorrupt.mockResolvedValue(undefined);
  const { RecordingShare } = await import("./share");
  render(<RecordingShare recording={recording} />);
  fireEvent.click(await screen.findByText("panels.recordings.forgetCorruptAudit"));
  await waitFor(() => expect(calls.forgetCorrupt).toHaveBeenCalledWith({ recordingId: "rec" }));
  expect(calls.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      destructive: true,
      message: "panels.recordings.forgetCorruptAuditMessage",
    }),
  );
});
