import type {
  DesktopRecordingBridge,
  DesktopRecordingMediaSegment,
  DesktopRecordingMetadata,
} from "@/desktop/host";

export interface RecordingMediaGap {
  key?: string;
  reason: string;
  streamId?: string | null;
  segmentId?: string | null;
}
export interface RecordingsState {
  recordings: DesktopRecordingMetadata[];
  incomplete: string[];
  selectedId: string | null;
  events: Array<{
    key: string;
    kind: string;
    payload: Record<string, unknown>;
    timelineMs?: number;
    memberId?: string;
  }>;
  cursor: number | null;
  eventTailIncomplete: boolean;
  media: DesktopRecordingMediaSegment[];
  mediaIncomplete: RecordingMediaGap[];
  mediaCursor: string | null;
  mediaPending: boolean;
  loading: boolean;
  error: string | null;
  recoveryError: string | null;
}
interface IncomingRecording extends Omit<DesktopRecordingMetadata, "status"> {
  status: string;
}
interface Bridge extends Pick<DesktopRecordingBridge, "readEvents" | "delete"> {
  list(input: { workspaceId: string }): Promise<{
    recordings: IncomingRecording[];
    incomplete: string[];
    recoveryError?: string | null;
  }>;
  listMedia(input: { recordingId: string; cursor: string | null; limit: number }): Promise<{
    segments: DesktopRecordingMediaSegment[];
    incomplete: RecordingMediaGap[];
    nextCursor: string | null;
    pending?: boolean;
  }>;
}
const PAGE_BYTES = 256 * 1024;
export function createRecordingsModel(
  bridge: Bridge,
  workspaceId: string,
  changed: (state: RecordingsState) => void,
) {
  let state: RecordingsState = {
    recordings: [],
    incomplete: [],
    selectedId: null,
    events: [],
    cursor: null,
    eventTailIncomplete: false,
    media: [],
    mediaIncomplete: [],
    mediaCursor: null,
    mediaPending: false,
    loading: false,
    error: null,
    recoveryError: null,
  };
  let generation = 0;
  let disposed = false;
  const update = (patch: Partial<RecordingsState>) => {
    state = { ...state, ...patch };
    if (!disposed) changed(state);
  };
  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const loadEvents = async (id: string, cursor: number, version: number) => {
    const page = await bridge.readEvents({ recordingId: id, cursor, maxBytes: PAGE_BYTES });
    if (disposed || version !== generation) return;
    update({
      events: [
        ...state.events,
        ...page.events.map((event, index) => ({
          ...(event as Omit<RecordingsState["events"][number], "key">),
          key: `${cursor}:${index}`,
        })),
      ],
      cursor: page.nextCursor,
      eventTailIncomplete: page.incompleteTail,
    });
  };
  const loadMedia = async (id: string, cursor: string | null, version: number) => {
    const page = await bridge.listMedia({ recordingId: id, cursor, limit: 100 });
    if (disposed || version !== generation) return;
    if (page.nextCursor !== null && page.nextCursor === cursor)
      throw new Error("Media cursor did not advance");
    update({
      media: [...state.media, ...page.segments].sort((a, b) => a.startMs - b.startMs),
      mediaIncomplete: [
        ...state.mediaIncomplete,
        ...page.incomplete.map((item, index) => ({
          ...item,
          key: `${cursor ?? "first"}:${index}`,
        })),
      ],
      mediaCursor: page.nextCursor,
      mediaPending: page.pending === true,
    });
  };
  const refresh = async () => {
    try {
      const data = await bridge.list({ workspaceId });
      const recordings: DesktopRecordingMetadata[] = data.recordings.flatMap((item) => {
        if (
          item.status !== "recording" &&
          item.status !== "complete" &&
          item.status !== "interrupted"
        )
          return [];
        return [{ ...item, status: item.status }];
      });
      const invalid = data.recordings
        .filter(
          (item) =>
            item.status !== "recording" &&
            item.status !== "complete" &&
            item.status !== "interrupted",
        )
        .map((item) => item.recordingId);
      if (!disposed)
        update({
          recordings,
          incomplete: [...new Set([...data.incomplete, ...invalid])],
          recoveryError: data.recoveryError ?? null,
        });
    } catch (error) {
      if (!disposed) update({ error: errorMessage(error) });
    }
  };
  return {
    getState: () => state,
    refresh,
    close() {
      generation++;
      update({ selectedId: null, events: [], media: [], error: null });
    },
    async open(id: string) {
      const version = ++generation;
      update({
        selectedId: id,
        events: [],
        cursor: null,
        eventTailIncomplete: false,
        media: [],
        mediaIncomplete: [],
        mediaCursor: null,
        mediaPending: false,
        loading: true,
        error: null,
      });
      try {
        await Promise.all([loadEvents(id, 0, version), loadMedia(id, null, version)]);
      } catch (error) {
        if (!disposed && version === generation) update({ error: errorMessage(error) });
      } finally {
        if (!disposed && version === generation) update({ loading: false });
      }
    },
    async loadMore() {
      if (!state.selectedId || state.loading || state.cursor === null) return;
      const id = state.selectedId,
        version = generation;
      update({ loading: true, error: null });
      try {
        await loadEvents(id, state.cursor, version);
      } catch (error) {
        if (!disposed && version === generation) update({ error: errorMessage(error) });
      } finally {
        if (!disposed && version === generation) update({ loading: false });
      }
    },
    async loadMoreMedia() {
      if (!state.selectedId || state.loading || state.mediaCursor === null) return;
      const id = state.selectedId,
        version = generation,
        cursor = state.mediaCursor;
      update({ loading: true, error: null });
      try {
        await loadMedia(id, cursor, version);
      } catch (error) {
        if (!disposed && version === generation) update({ error: errorMessage(error) });
      } finally {
        if (!disposed && version === generation) update({ loading: false });
      }
    },
    async remove(id: string) {
      try {
        await bridge.delete({ recordingId: id });
        if (state.selectedId === id) {
          generation++;
          update({ selectedId: null, events: [], media: [] });
        }
        await refresh();
      } catch (error) {
        if (!disposed) update({ error: errorMessage(error) });
      }
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
