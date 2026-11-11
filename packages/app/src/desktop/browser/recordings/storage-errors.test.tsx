import { describe, expect, it } from "vitest";
const load = () => import("./storage-errors");
describe("recording storage errors", () => {
  it("preserves a startup recovery problem in the recordings panel state", async () => {
    const { createRecordingsModel } = await import("./model");
    const model = createRecordingsModel(
      {
        list: async () => ({ recordings: [], incomplete: [], recoveryError: "unavailable" }),
        readEvents: async () => ({ events: [], nextCursor: null, incompleteTail: false }),
        listMedia: async () => ({ segments: [], incomplete: [], nextCursor: null }),
        delete: async () => {},
      },
      "w",
      () => {},
    );
    await model.refresh();
    expect(model.getState().recoveryError).toBe("unavailable");
  });
  it("keeps the classified storage reason when an active recording stops", async () => {
    const { classifyStorageError } = await load();
    const { createRecordingControl } = await import("../recording-control");
    let emit!: (state: import("@/desktop/host").DesktopRecordingState) => void;
    const control = createRecordingControl(
      {
        start: async () => ({ recordingId: "r", status: "recording" }),
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
    emit({ browserId: "tab", recordingId: "r", status: "stopping", reason: "disk-full" });
    expect(classifyStorageError(control.getState().error)).toBe("disk-full");
    expect(control.getState().reason).toBe("disk-full");
    emit({ browserId: "tab", recordingId: "r", status: "interrupted", reason: "quota" });
    expect(classifyStorageError(control.getState().error)).toBe("quota");
    expect(control.getState().reason).toBe("quota");
  });
  it("distinguishes quota and disk-full errors from other failures", async () => {
    const { classifyStorageError } = await load();
    expect(classifyStorageError(new Error("Recording storage quota exceeded"))).toBe("quota");
    expect(classifyStorageError(Object.assign(new Error("write failed"), { code: "ENOSPC" }))).toBe(
      "disk-full",
    );
    expect(classifyStorageError(new Error("ENOSPC: no space left on device"))).toBe("disk-full");
    expect(classifyStorageError(Object.assign(new Error("quota"), { code: "EDQUOT" }))).toBe(
      "disk-full",
    );
    expect(classifyStorageError(new Error("permission denied"))).toBe("other");
  });
});
