import type { DesktopRecordingBridge, DesktopRecordingState } from "@/desktop/host";

type Status = "loading" | "idle" | "starting" | "recording" | "stopping";
export const RECORDING_INTERRUPTED = "Recording interrupted";
export interface RecordingControlState {
  status: Status;
  recordingId: string | null;
  error: string | null;
  reason?: "quota" | "disk-full";
  audioRequested?: boolean;
  audioStatus?: "starting" | "captured" | "unavailable" | "disabled";
  audioReason?: string;
}
type Bridge = Pick<DesktopRecordingBridge, "start" | "stop" | "active" | "onState">;
function audioState(event: DesktopRecordingState, state: RecordingControlState) {
  return {
    audioRequested: event.audioRequested ?? state.audioRequested,
    audioStatus: event.audioStatus ?? state.audioStatus,
    audioReason: event.audioReason ?? state.audioReason,
  };
}

export function createRecordingControl(
  bridge: Bridge,
  browserId: string,
  changed: (state: RecordingControlState) => void,
) {
  let state: RecordingControlState = { status: "loading", recordingId: null, error: null };
  let unsubscribe = () => {};
  let revision = 0;
  let disposed = false;
  let busy = false;
  let startPending = false;
  const set = (next: RecordingControlState) => {
    state = next;
    if (!disposed) changed(next);
  };
  const apply = (event: DesktopRecordingState) => {
    if (event.browserId !== browserId || disposed) return;
    if (state.recordingId && state.recordingId !== event.recordingId) return;
    if (
      startPending &&
      !state.recordingId &&
      (event.status === "complete" || event.status === "interrupted")
    )
      return;
    revision++;
    const storageReason = startPending ? undefined : event.reason;
    let reason: string | null = null;
    if (storageReason === "quota") reason = "Recording storage quota exceeded";
    if (storageReason === "disk-full") reason = "ENOSPC";
    const audio = audioState(event, state);
    if (event.status === "complete" || event.status === "interrupted") {
      set({
        status: "idle",
        recordingId: null,
        error:
          event.status === "interrupted" && !startPending
            ? (reason ?? RECORDING_INTERRUPTED)
            : null,
        reason: storageReason,
        ...audio,
      });
    } else {
      set({
        status: event.status,
        recordingId: event.recordingId,
        error: event.status === "stopping" ? reason : null,
        reason: event.status === "stopping" ? storageReason : undefined,
        ...audio,
      });
    }
  };
  const failure = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      "",
    );
  const handleFailure = async (error: unknown, id: string | null, before: number) => {
    if (id) {
      try {
        const current = await bridge.active({ browserId });
        if (revision === before)
          set({
            ...(current?.status === "recording" ? audioState(current, state) : {}),
            status: current?.status === "recording" ? "recording" : "idle",
            recordingId: current?.status === "recording" ? current.recordingId : null,
            error: failure(error),
          });
      } catch {
        if (revision === before) set({ status: "idle", recordingId: null, error: failure(error) });
      }
    } else if (revision === before || state.status !== "recording") {
      set({ status: "idle", recordingId: null, error: failure(error) });
    }
  };
  return {
    getState: () => state,
    async connect() {
      unsubscribe = bridge.onState(apply);
      const before = revision;
      try {
        const current = await bridge.active({ browserId });
        if (disposed || revision !== before) return;
        if (current) apply(current);
        else set({ status: "idle", recordingId: null, error: null });
      } catch (error) {
        if (!disposed && revision === before)
          set({ status: "idle", recordingId: null, error: failure(error) });
      }
    },
    async toggle(audio = false) {
      if (disposed || busy || (state.status !== "idle" && state.status !== "recording")) return;
      busy = true;
      const id = state.recordingId;
      startPending = !id;
      const before = revision;
      set({
        ...state,
        status: id ? "stopping" : "starting",
        error: null,
        ...(id
          ? {}
          : {
              audioRequested: audio,
              audioStatus: audio ? "starting" : "disabled",
              audioReason: undefined,
            }),
      });
      try {
        if (id) {
          await bridge.stop({ recordingId: id });
          if (revision === before) set({ status: "idle", recordingId: null, error: null });
        } else {
          const result = await bridge.start(audio ? { browserId, audio: true } : { browserId });
          if (revision === before)
            set({ ...state, status: "recording", recordingId: result.recordingId, error: null });
        }
      } catch (error) {
        await handleFailure(error, id, before);
      } finally {
        busy = false;
        startPending = false;
      }
    },
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}
