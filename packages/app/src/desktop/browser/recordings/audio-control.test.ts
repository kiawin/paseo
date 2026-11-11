import { describe, expect, it, vi } from "vitest";
import { createRecordingControl } from "../recording-control";
import type { DesktopRecordingState } from "@/desktop/host";

describe("recording audio control", () => {
  it("retains audio status if stopping fails and recording remains active", async () => {
    const control = createRecordingControl(
      {
        start: async () => ({ recordingId: "r", status: "recording" }),
        stop: async () => {
          throw new Error("stop failed");
        },
        active: async () => ({
          browserId: "tab",
          recordingId: "r",
          status: "recording",
          audioRequested: true,
          audioStatus: "captured",
        }),
        onState: () => () => {},
      },
      "tab",
      () => {},
    );
    await control.connect();
    await control.toggle();
    expect(control.getState()).toMatchObject({
      status: "recording",
      audioRequested: true,
      audioStatus: "captured",
      error: "stop failed",
    });
  });
  it("clears the pending audio state after a failed start", async () => {
    const control = createRecordingControl(
      {
        start: async () => {
          throw new Error("failed");
        },
        stop: async () => {},
        active: async () => null,
        onState: () => () => {},
      },
      "tab",
      () => {},
    );
    await control.connect();
    await control.toggle(true);
    expect(control.getState()).toMatchObject({ status: "idle", error: "failed" });
    expect(control.getState().audioRequested).toBeUndefined();
    expect(control.getState().audioStatus).toBeUndefined();
  });
  it("requests audio only when selected and exposes capture and denial status", async () => {
    let emit!: (event: DesktopRecordingState) => void;
    const start = vi.fn(async (_input: { browserId: string; audio?: boolean }) => ({
      recordingId: "r",
      status: "recording",
    }));
    const control = createRecordingControl(
      {
        start,
        stop: async () => {},
        active: async () => null,
        onState: (handler) => {
          emit = handler;
          return () => {};
        },
      },
      "tab",
      () => {},
    );
    await control.connect();
    await control.toggle(true);
    expect(start).toHaveBeenCalledWith({ browserId: "tab", audio: true });
    emit({
      browserId: "tab",
      recordingId: "r",
      status: "recording",
      audioRequested: true,
      audioStatus: "captured",
    });
    expect(control.getState()).toMatchObject({ audioRequested: true, audioStatus: "captured" });
    emit({
      browserId: "tab",
      recordingId: "r",
      status: "recording",
      audioRequested: true,
      audioStatus: "unavailable",
      audioReason: "denied",
    });
    expect(control.getState()).toMatchObject({ audioStatus: "unavailable", audioReason: "denied" });
  });
  it("leaves audio disabled by default", async () => {
    const start = vi.fn(async (_input: { browserId: string; audio?: boolean }) => ({
      recordingId: "r",
      status: "recording",
    }));
    const control = createRecordingControl(
      { start, stop: async () => {}, active: async () => null, onState: () => () => {} },
      "tab",
      () => {},
    );
    await control.connect();
    await control.toggle();
    expect(start).toHaveBeenCalledWith({ browserId: "tab" });
    expect(control.getState().audioStatus).toBe("disabled");
  });
});
