import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { confirmDialog } from "@/utils/confirm-dialog";
import { createRecordingsModel, type RecordingsState } from "./model";

function EventRow({
  event,
  index,
  select,
}: {
  event: RecordingsState["events"][number];
  index: number;
  select: (index: number) => void;
}) {
  const onPress = useCallback(() => select(index), [select, index]);
  const summary = useMemo(() => {
    const payload = event.payload;
    if (event.kind === "gap" && typeof payload?.reason === "string")
      return payload.reason.slice(0, 2048);
    if (event.kind !== "network" || !payload || typeof payload !== "object") return event.kind;
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
  }, [event]);
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
export function RecordingsPane({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RecordingsState | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [model, setModel] = useState<ReturnType<typeof createRecordingsModel> | null>(null);
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
    model?.close();
    void model?.refresh();
  }, [model]);
  const detail = useMemo(() => {
    if (selectedEvent === null || !snapshot?.events[selectedEvent]) return "";
    const { key: _key, ...event } = snapshot.events[selectedEvent];
    return JSON.stringify(event, null, 2);
  }, [snapshot?.events, selectedEvent]);
  const showEntireDetail = useCallback(() => setShowFull(true), []);
  const selectEvent = useCallback((index: number) => {
    setShowFull(false);
    setSelectedEvent(index);
  }, []);
  const refreshSelected = useCallback(() => {
    setSelectedEvent(null);
    setShowFull(false);
    if (snapshot?.selectedId) void model?.open(snapshot.selectedId);
  }, [model, snapshot?.selectedId]);
  const deleteSelected = useCallback(() => {
    if (snapshot?.selectedId) void remove(snapshot.selectedId);
  }, [remove, snapshot?.selectedId]);
  const open = useCallback(
    (id: string) => {
      setSelectedEvent(null);
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
      {snapshot.error ? <Text style={styles.error}>{snapshot.error}</Text> : null}
      {snapshot.selectedId ? (
        <>
          <Button size="sm" variant="ghost" onPress={back}>
            {t("panels.recordings.back")}
          </Button>
          <Text selectable style={styles.heading}>
            {recordingHeading(snapshot)}
          </Text>
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
          {snapshot.mediaPending ? (
            <Text style={styles.muted}>{t("panels.recordings.mediaPending")}</Text>
          ) : null}
          {snapshot.mediaIncomplete.map((item) => (
            <Text key={item.key} style={styles.error}>
              {item.streamId} {item.segmentId}: {item.reason}
            </Text>
          ))}
          {snapshot.media.map((segment) => (
            <Text key={`${segment.streamId}:${segment.segmentId}`} selectable style={styles.muted}>
              {segment.streamId} · {segment.segmentId} · {segment.mimeType} · {segment.startMs}ms +{" "}
              {segment.durationMs}ms
            </Text>
          ))}
          {snapshot.events.map((event, index) => (
            <EventRow key={event.key} event={event} index={index} select={selectEvent} />
          ))}
          {selectedEvent !== null && snapshot.events[selectedEvent] ? (
            <>
              <Text selectable style={styles.detail}>
                {showFull ? detail : detail.slice(0, 131072)}
              </Text>
              {!showFull && detail.length > 131072 ? (
                <Button size="sm" onPress={showEntireDetail}>
                  {t("panels.recordings.showFull")}
                </Button>
              ) : null}
            </>
          ) : null}
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
