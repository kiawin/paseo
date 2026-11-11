import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { confirmDialog } from "@/utils/confirm-dialog";
import { createRecordingsModel, type RecordingsState } from "./model";
import { RecordingPlayer, type RecordingSeek } from "./player";
import { RecordingShare } from "./share";
import { createPlayback } from "./playback";
import { classifyStorageError } from "./storage-errors";

function networkSummary(payload: Record<string, unknown>): string {
  const request = payload.request as
    | { method?: string; url?: string; body?: { state?: string } }
    | undefined;
  const response = payload.response as
    | { status?: number; body?: { state?: string } }
    | null
    | undefined;
  return `${request?.method ?? ""} ${request?.url ?? ""} ${response?.status ?? ""} · ${request?.body?.state ?? ""} / ${response?.body?.state ?? ""}`.slice(
    0,
    2048,
  );
}
function EventRow({
  event,
  index,
  select,
}: {
  event: RecordingsState["events"][number];
  index: number;
  select: (index: number) => void;
}) {
  const { t } = useTranslation();
  const onPress = useCallback(() => select(index), [select, index]);
  const summary = useMemo(() => {
    const payload = event.payload;
    if (event.kind === "media" && payload?.type === "audio-status") {
      if (payload.status === "captured") return t("workspace.browser.controls.audioRecording");
      if (payload.status === "unavailable") return t("workspace.browser.controls.audioUnavailable");
      if (payload.status === "disabled") return t("workspace.browser.controls.audioOff");
    }
    if (event.kind === "gap" && typeof payload?.reason === "string")
      return payload.reason.slice(0, 2048);
    if (event.kind !== "network" || !payload || typeof payload !== "object") return event.kind;
    return networkSummary(payload);
  }, [event, t]);
  return (
    <PressHighlight accessibilityRole="button" onPress={onPress} style={styles.row}>
      <Text selectable style={styles.label}>
        {event.kind}
      </Text>
      <Text numberOfLines={2} style={styles.muted}>
        {summary}
      </Text>
    </PressHighlight>
  );
}
function RecordingRow({
  item,
  open,
}: {
  item: RecordingsState["recordings"][number];
  open: (id: string) => void;
}) {
  const { t } = useTranslation();
  const onPress = useCallback(() => open(item.recordingId), [open, item.recordingId]);
  return (
    <PressHighlight accessibilityRole="button" onPress={onPress} style={styles.row}>
      <Text style={styles.label}>{recordingLabel(item)}</Text>
      <Text style={styles.muted}>{t(`panels.recordings.status.${item.status}`)}</Text>
      {item.captureErrors?.length || item.recoveryWarnings?.length ? (
        <Text style={styles.error}>{t("panels.recordings.incomplete")}</Text>
      ) : null}
    </PressHighlight>
  );
}
function IncompleteRow({ id, remove }: { id: string; remove: (id: string) => void }) {
  const { t } = useTranslation();
  const onPress = useCallback(() => remove(id), [remove, id]);
  return (
    <View style={styles.row}>
      <Text selectable style={styles.error}>
        {t("panels.recordings.incomplete")}: {id}
      </Text>
      <Button size="sm" variant="ghost" onPress={onPress}>
        {t("panels.recordings.delete")}
      </Button>
    </View>
  );
}
function recordingLabel(item: RecordingsState["recordings"][number]): string {
  return item.title || new Date(item.startedAt).toLocaleString();
}
function recordingHeading(snapshot: RecordingsState): string {
  const item = snapshot.recordings.find(
    (candidate) => candidate.recordingId === snapshot.selectedId,
  );
  return item ? recordingLabel(item) : snapshot.selectedId || "";
}
function EventTimingNotice({ event }: { event: RecordingsState["events"][number] }) {
  const { t } = useTranslation();
  if (typeof event.timelineMs === "number" && Number.isFinite(event.timelineMs)) return null;
  return <Text style={styles.muted}>{t("panels.recordings.eventUntimed")}</Text>;
}
function EventDetails({
  event,
  detail,
  showFull,
  showEntireDetail,
}: {
  event?: RecordingsState["events"][number];
  detail: string;
  showFull: boolean;
  showEntireDetail: () => void;
}) {
  const { t } = useTranslation();
  if (!event) return null;
  return (
    <>
      <EventTimingNotice event={event} />
      <Text selectable style={styles.detail}>
        {showFull ? detail : detail.slice(0, 131072)}
      </Text>
      {!showFull && detail.length > 131072 ? (
        <Button size="sm" onPress={showEntireDetail}>
          {t("panels.recordings.showFull")}
        </Button>
      ) : null}
    </>
  );
}
function StorageError({ message }: { message: string }) {
  const { t } = useTranslation();
  const kind = classifyStorageError(message);
  if (kind === "quota")
    return <Text style={styles.error}>{t("panels.recordings.storageQuota")}</Text>;
  if (kind === "disk-full")
    return <Text style={styles.error}>{t("panels.recordings.diskFull")}</Text>;
  return <Text style={styles.error}>{message}</Text>;
}
function RecordingWarnings({ snapshot }: { snapshot: RecordingsState }) {
  const { t } = useTranslation();
  const item = snapshot.recordings.find(
    (candidate) => candidate.recordingId === snapshot.selectedId,
  );
  const errors = [...new Set([...(item?.captureErrors ?? []), ...(item?.recoveryWarnings ?? [])])];
  const labels: Record<string, string> = {
    "incomplete-event-tail": t("panels.recordings.incompleteTail"),
    "unpublished-metadata": t("panels.recordings.unpublishedMetadata"),
    "event-log-unreadable": t("panels.recordings.eventLogUnreadable"),
    "recovery-write-failed": t("panels.recordings.recoveryWriteFailed"),
  };
  return (
    <>
      {item?.audioRequested && item.audioStatus === "unavailable" ? (
        <Text style={styles.error}>{t("workspace.browser.controls.audioUnavailable")}</Text>
      ) : null}
      {item?.audioRequested && item.audioStatus === "starting" && item.status !== "recording" ? (
        <Text style={styles.muted}>{t("panels.recordings.audioUnknown")}</Text>
      ) : null}
      {errors.map((error) => (
        <StorageError key={error} message={labels[error] ?? error} />
      ))}
    </>
  );
}
function recordingDuration(snapshot: RecordingsState): number {
  const item = snapshot.recordings.find(
    (candidate) => candidate.recordingId === snapshot.selectedId,
  );
  const end = item?.endedAt && item.startedAt ? Math.max(0, item.endedAt - item.startedAt) : 0;
  return snapshot.events.reduce(
    (duration, event) =>
      typeof event.timelineMs === "number" && Number.isFinite(event.timelineMs)
        ? Math.max(duration, event.timelineMs)
        : duration,
    end,
  );
}
export function RecordingsPane({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RecordingsState | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [playbackSeek, setPlaybackSeek] = useState<RecordingSeek | null>(null);
  const [model, setModel] = useState<ReturnType<typeof createRecordingsModel> | null>(null);
  const viewNumbers = useMemo(
    () =>
      new Map(
        createPlayback(snapshot?.media ?? [])
          .views()
          .map((id, index) => [id, index + 1]),
      ),
    [snapshot?.media],
  );
  useEffect(() => {
    const bridge = getDesktopHost()?.recording;
    if (!bridge) return;
    const instance = createRecordingsModel(bridge, workspaceId, setSnapshot);
    setModel(instance);
    setSnapshot(instance.getState());
    void instance.refresh();
    return () => instance.dispose();
  }, [workspaceId]);
  const remove = useCallback(
    async (id: string) => {
      if (!model) return;
      const confirmed = await confirmDialog({
        title: t("panels.recordings.deleteTitle"),
        message: t("panels.recordings.deleteMessage"),
        confirmLabel: t("panels.recordings.delete"),
        destructive: true,
      });
      if (confirmed) await model.remove(id);
    },
    [model, t],
  );
  const back = useCallback(() => {
    setSelectedEvent(null);
    setPlaybackSeek(null);
    model?.close();
    void model?.refresh();
  }, [model]);
  const detail = useMemo(() => {
    if (selectedEvent === null || !snapshot?.events[selectedEvent]) return "";
    const { key: _key, ...event } = snapshot.events[selectedEvent];
    return JSON.stringify(event, null, 2);
  }, [snapshot?.events, selectedEvent]);
  const showEntireDetail = useCallback(() => setShowFull(true), []);
  const selectEvent = useCallback(
    (index: number) => {
      setShowFull(false);
      setSelectedEvent(index);
      const event = snapshot?.events[index];
      const clock = createPlayback(snapshot?.media ?? []);
      if (event && typeof event.memberId === "string" && clock.seekEvent(event))
        setPlaybackSeek((previous) => ({
          timeMs: clock.getState().timeMs,
          streamId: event.memberId!,
          nonce: (previous?.nonce ?? 0) + 1,
        }));
    },
    [snapshot?.events, snapshot?.media],
  );
  const refreshSelected = useCallback(() => {
    setSelectedEvent(null);
    setShowFull(false);
    setPlaybackSeek(null);
    if (snapshot?.selectedId) void model?.open(snapshot.selectedId);
  }, [model, snapshot?.selectedId]);
  const deleteSelected = useCallback(() => {
    if (snapshot?.selectedId) void remove(snapshot.selectedId);
  }, [remove, snapshot?.selectedId]);
  const open = useCallback(
    (id: string) => {
      setSelectedEvent(null);
      setPlaybackSeek(null);
      void model?.open(id);
    },
    [model],
  );
  const loadEvents = useCallback(() => {
    void model?.loadMore();
  }, [model]);
  const loadMedia = useCallback(() => {
    void model?.loadMoreMedia();
  }, [model]);
  const removeRow = useCallback(
    (id: string) => {
      void remove(id);
    },
    [remove],
  );
  if (!model || !snapshot)
    return (
      <View style={styles.container}>
        <Text style={styles.muted}>{t("panels.recordings.unavailable")}</Text>
      </View>
    );
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {snapshot.error ? <StorageError message={snapshot.error} /> : null}
      {snapshot.recoveryError ? (
        <Text style={styles.error}>
          {t(
            snapshot.recoveryError === "single-instance-lock-disabled"
              ? "panels.recordings.recoveryDisabled"
              : "panels.recordings.recoveryProblem",
          )}
        </Text>
      ) : null}
      {snapshot.selectedId ? (
        <>
          <Button size="sm" variant="ghost" onPress={back}>
            {t("panels.recordings.back")}
          </Button>
          <Text selectable style={styles.heading}>
            {recordingHeading(snapshot)}
          </Text>
          <RecordingWarnings snapshot={snapshot} />
          {snapshot.recordings
            .filter((item) => item.recordingId === snapshot.selectedId)
            .map((item) => (
              <RecordingShare key={item.recordingId} recording={item} />
            ))}
          <RecordingPlayer
            key={snapshot.selectedId}
            recordingId={snapshot.selectedId}
            segments={snapshot.media}
            hasMore={snapshot.mediaCursor !== null}
            seek={playbackSeek}
            pending={snapshot.mediaPending}
            durationMs={recordingDuration(snapshot)}
          />
          {snapshot.recordings
            .filter((item) => item.recordingId === snapshot.selectedId)
            .map((item) => (
              <Text key={item.recordingId} style={styles.muted}>
                {t(`panels.recordings.status.${item.status}`)}
              </Text>
            ))}
          <Button size="sm" variant="ghost" onPress={refreshSelected}>
            {t("panels.recordings.refresh")}
          </Button>
          <Button size="sm" variant="ghost" onPress={deleteSelected}>
            {t("panels.recordings.delete")}
          </Button>
          {snapshot.eventTailIncomplete ? (
            <Text style={snapshot.mediaPending ? styles.muted : styles.error}>
              {t("panels.recordings.incompleteTail")}
            </Text>
          ) : null}
          {snapshot.mediaIncomplete.map((item) => (
            <Text key={item.key} style={styles.error}>
              {item.streamId && viewNumbers.has(item.streamId)
                ? t("panels.recordings.viewGap", {
                    n: viewNumbers.get(item.streamId),
                    reason: item.reason,
                  })
                : t("panels.recordings.unknownViewGap", { reason: item.reason })}
            </Text>
          ))}
          {snapshot.events.map((event, index) => (
            <EventRow key={event.key} event={event} index={index} select={selectEvent} />
          ))}
          <EventDetails
            event={selectedEvent === null ? undefined : snapshot.events[selectedEvent]}
            detail={detail}
            showFull={showFull}
            showEntireDetail={showEntireDetail}
          />
          {snapshot.cursor !== null ? (
            <Button size="sm" disabled={snapshot.loading} onPress={loadEvents}>
              {t("panels.recordings.moreEvents")}
            </Button>
          ) : null}
          {snapshot.mediaCursor !== null ? (
            <Button size="sm" disabled={snapshot.loading} onPress={loadMedia}>
              {t("panels.recordings.moreMedia")}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.heading}>{t("panels.recordings.label")}</Text>
          {!snapshot.recordings.length && !snapshot.incomplete.length ? (
            <Text style={styles.muted}>{t("panels.recordings.empty")}</Text>
          ) : null}
          {snapshot.recordings.map((item) => (
            <RecordingRow key={item.recordingId} item={item} open={open} />
          ))}
          {snapshot.incomplete.map((id) => (
            <IncompleteRow key={id} id={id} remove={removeRow} />
          ))}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: 12, gap: 8 },
  heading: { color: theme.colors.foreground, fontWeight: "600" },
  label: { color: theme.colors.foreground },
  muted: { color: theme.colors.foregroundMuted },
  error: { color: theme.colors.destructive },
  row: { paddingVertical: 8, borderBottomWidth: 1, borderColor: theme.colors.border },
  detail: { color: theme.colors.foreground, fontFamily: "monospace" },
}));
