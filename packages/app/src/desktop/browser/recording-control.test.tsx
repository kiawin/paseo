import { describe, expect, it, vi } from "vitest";

const load = () => import("./recording-control");

interface State {
  browserId: string;
  recordingId: string;
  status: "starting" | "recording" | "complete" | "interrupted";
}
function bridge() {
  let listener: (state: State) => void = () => {};
  return {
    start: vi.fn(async (_input: { browserId: string }) => ({
      recordingId: "r1",
      status: "recording",
    })),
    stop: vi.fn(async (_input: { recordingId: string }) => {}),
    active: vi.fn(async (_input: { browserId: string }): Promise<State | null> => null),
    onState: (fn: (state: State) => void) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
    emit: (state: State) => listener(state),
  };
}

describe("browser recording control", () => {
  it("ignores an old terminal event during startup before the new ID arrives", async () => {
    const { createRecordingControl } = await load();
    const host = bridge();
    let resolve!: (value: { recordingId: string; status: string }) => void;
    host.start.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const control = createRecordingControl(host, "tab1", () => {});
    await control.connect();
    const pending = control.toggle();
    host.emit({ browserId: "tab1", recordingId: "old", status: "complete" });
    resolve({ recordingId: "new", status: "recording" });
    await pending;
    expect(control.getState()).toMatchObject({ status: "recording", recordingId: "new" });
  });
  it("reports the actual startup failure once after an interruption event", async () => {
    const { createRecordingControl } = await load();
    const host = bridge();
    let reject!: (error: Error) => void;
    host.start.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const updates: Array<{ error: string | null }> = [];
    const control = createRecordingControl(host, "tab1", (state) => updates.push(state));
    await control.connect();
    const pending = control.toggle();
    host.emit({ browserId: "tab1", recordingId: "new", status: "starting" });
    host.emit({ browserId: "tab1", recordingId: "new", status: "interrupted" });
    reject(new Error("startup failed"));
    await pending;
    expect(updates.filter((state) => state.error).map((state) => state.error)).toEqual([
      "startup failed",
    ]);
  });
  it("reconciles a failed stop with the active desktop state", async () => {
    const { createRecordingControl } = await load();
    const host = bridge();
    host.active.mockResolvedValue({ browserId: "tab1", recordingId: "r1", status: "recording" });
    host.stop.mockRejectedValue(new Error("stop failed"));
    const control = createRecordingControl(host, "tab1", () => {});
    await control.connect();
    await control.toggle();
    expect(control.getState()).toMatchObject({
      status: "recording",
      recordingId: "r1",
      error: "stop failed",
    });
  });
  it("ignores a late terminal event from a previous recording of the same tab", async () => {
    const { createRecordingControl } = await load();
    const host = bridge();
    host.active.mockResolvedValue({ browserId: "tab1", recordingId: "new", status: "recording" });
    const control = createRecordingControl(host, "tab1", () => {});
    await control.connect();
    host.emit({ browserId: "tab1", recordingId: "old", status: "complete" });
    expect(control.getState()).toMatchObject({ status: "recording", recordingId: "new" });
  });
  it("starts and stops the selected browser and exposes the active state", async () => {
    const { createRecordingControl } = await load();
    const host = bridge();
    const control = createRecordingControl(host, "tab1", () => {});
    await control.connect();
    await control.toggle();
    expect(host.start).toHaveBeenCalledWith({ browserId: "tab1" });
    expect(control.getState()).toMatchObject({ status: "recording", recordingId: "r1" });
    await control.toggle();
    expect(host.stop).toHaveBeenCalledWith({ recordingId: "r1" });
    expect(control.getState()).toMatchObject({ status: "idle", recordingId: null });
    control.dispose();
  });
  it("restores a recording when the pane remounts and ignores other browsers", async () => {
    const { createRecordingControl } = await load();
    const host = bridge();
    host.active.mockResolvedValue({ browserId: "tab1", recordingId: "r2", status: "recording" });
    const control = createRecordingControl(host, "tab1", () => {});
    await control.connect();
    host.emit({ browserId: "tab2", recordingId: "other", status: "interrupted" });
    expect(control.getState()).toMatchObject({ status: "recording", recordingId: "r2" });
    host.emit({ browserId: "tab1", recordingId: "r2", status: "interrupted" });
    expect(control.getState()).toMatchObject({
      status: "idle",
      recordingId: null,
      error: expect.stringContaining("interrupted"),
    });
  });
  it("does not overwrite newer events with a stale active snapshot", async () => {
    const { createRecordingControl } = await load();
    const host = bridge();
    let resolve!: (value: State | null) => void;
    host.active.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const control = createRecordingControl(host, "tab1", () => {});
    const connected = control.connect();
    host.emit({ browserId: "tab1", recordingId: "r1", status: "complete" });
    resolve({ browserId: "tab1", recordingId: "r1", status: "recording" });
    await connected;
    expect(control.getState()).toMatchObject({ status: "idle", recordingId: null });
  });
  it("reports failures and does not claim to be recording after start failure", async () => {
    const { createRecordingControl } = await load();
    const host = bridge();
    host.start.mockRejectedValue(new Error("startup failed"));
    const control = createRecordingControl(host, "tab1", () => {});
    await control.connect();
    await control.toggle();
    expect(control.getState()).toMatchObject({
      status: "idle",
      recordingId: null,
      error: expect.stringContaining("startup failed"),
    });
  });
  it("prevents duplicate starts while the first is pending", async () => {
    const { createRecordingControl } = await load();
    const host = bridge();
    let resolve!: (value: { recordingId: string; status: string }) => void;
    host.start.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const control = createRecordingControl(host, "tab1", () => {});
    await control.connect();
    const first = control.toggle();
    await control.toggle();
    expect(host.start).toHaveBeenCalledTimes(1);
    resolve({ recordingId: "r1", status: "recording" });
    await first;
  });
});
