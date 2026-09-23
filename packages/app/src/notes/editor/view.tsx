import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { MarkdownRenderer } from "@/components/markdown/renderer";
import { getRevisionedTextConflictCallout } from "@/editor/revisioned-text-model";
import { FileSourceView } from "@/file-panels/source/readonly/view";
import { formatTimeAgo } from "@/utils/time";
import { NoteConflictAlert } from "./conflict-alert";
import { NoteViewControl } from "./view-mode";
import type { NoteEditorViewProps } from "./view-types";

// Source highlights the body as Markdown. A note is at most 64 KiB, inside the highlight budget.
const SOURCE_LOCATION = { path: "note.md" };

export function NoteEditorView({
  model,
  note,
  view,
  onViewChange,
  imageBehavior,
  remoteImageLoadLabel,
  theme,
  onRetry,
}: NoteEditorViewProps) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const conflict = getRevisionedTextConflictCallout(snapshot);
  const handleReload = useCallback(() => void model.reload(), [model]);
  return (
    <View style={styles.container} testID="note-view">
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text style={styles.title}>{note?.displayTitle ?? t("panels.notes.newNote")}</Text>
          {note ? (
            <Text style={styles.meta}>
              {t("panels.notes.updated", { time: formatTimeAgo(new Date(note.updatedAt)) })}
            </Text>
          ) : null}
        </View>
        <NoteViewControl view={view} onViewChange={onViewChange} />
      </View>
      <NoteConflictAlert
        callout={conflict}
        onReload={conflict?.kind === "changed" ? handleReload : undefined}
        onRetry={onRetry}
      />
      {view === "preview" ? (
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.content}
          testID="note-preview"
        >
          <MarkdownRenderer
            text={snapshot.content}
            remoteImageBehavior={imageBehavior}
            remoteImageLoadLabel={remoteImageLoadLabel}
          />
        </ScrollView>
      ) : (
        <FileSourceView
          content={snapshot.content}
          filename={SOURCE_LOCATION.path}
          location={SOURCE_LOCATION}
          navigationRevision={0}
          presentation="highlighted"
          theme={theme}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  heading: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
  },
  meta: { color: theme.colors.mutedForeground, fontSize: theme.fontSize.xs },
  content: { padding: theme.spacing[4] },
}));
