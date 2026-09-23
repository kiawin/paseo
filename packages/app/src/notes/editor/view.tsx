import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { MarkdownRenderer } from "@/components/markdown/renderer";
import { getRevisionedTextConflictCallout } from "@/editor/revisioned-text-model";
import { formatTimeAgo } from "@/utils/time";
import { NoteConflictAlert } from "./conflict-alert";
import type { NoteEditorViewProps } from "./view-types";

export function NoteEditorView({
  model,
  note,
  imageBehavior,
  remoteImageLoadLabel,
  onRetry,
}: NoteEditorViewProps) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const conflict = getRevisionedTextConflictCallout(snapshot);
  const handleReload = useCallback(() => void model.reload(), [model]);
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} testID="note-view">
      <Text style={styles.title}>{note?.displayTitle ?? t("panels.notes.newNote")}</Text>
      {note ? (
        <Text style={styles.meta}>
          {t("panels.notes.updated", { time: formatTimeAgo(new Date(note.updatedAt)) })}
        </Text>
      ) : null}
      <NoteConflictAlert
        callout={conflict}
        onReload={conflict?.kind === "changed" ? handleReload : undefined}
        onRetry={onRetry}
      />
      <View style={styles.body}>
        <MarkdownRenderer
          text={snapshot.content}
          remoteImageBehavior={imageBehavior}
          remoteImageLoadLabel={remoteImageLoadLabel}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  content: { padding: theme.spacing[4], gap: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
  },
  meta: { color: theme.colors.mutedForeground, fontSize: theme.fontSize.xs },
  body: { marginTop: theme.spacing[2] },
}));
