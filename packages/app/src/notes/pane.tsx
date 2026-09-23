import { Fragment, useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { useProjectNotes } from "@/notes/hooks";
import {
  groupFederatedNotesByHost,
  noteTargetForRow,
  type FederatedNoteRecord,
  type NoteHostError,
  type NoteTarget,
} from "@/notes/federation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { isWeb } from "@/constants/platform";
import { formatTimeAgo } from "@/utils/time";

function NoteRow({
  note,
  onOpen,
}: {
  note: FederatedNoteRecord;
  onOpen: (target: NoteTarget) => void;
}) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => onOpen(noteTargetForRow(note)), [note, onOpen]);
  return (
    <Pressable
      style={styles.row}
      onPress={handleOpen}
      testID={`note-row-${note.noteId}`}
      accessibilityRole="button"
      accessibilityLabel={note.displayTitle}
    >
      <Text style={styles.rowTitle} numberOfLines={1}>
        {note.displayTitle}
      </Text>
      <Text style={styles.rowMeta} numberOfLines={1}>
        {t("panels.notes.hostTag", { host: note.serverName })} ·{" "}
        {t("panels.notes.updated", {
          time: formatTimeAgo(new Date(note.updatedAt)),
        })}
      </Text>
    </Pressable>
  );
}

function HostErrorsNotice({ errors }: { errors: NoteHostError[] }) {
  const { t } = useTranslation();
  if (errors.length === 0) return null;
  return (
    <Alert
      testID="notes-host-errors"
      variant="warning"
      title={t("panels.notes.hostsUnavailable")}
      description={errors
        .map((error) => {
          if (error.reason === "unsupported") {
            return t("panels.notes.hostUnsupported", { host: error.serverName });
          }
          if (error.reason === "failed") {
            return t("panels.notes.hostLoadFailed", { host: error.serverName });
          }
          return t("panels.notes.hostUnreachable", { host: error.serverName });
        })
        .join(" ")}
    />
  );
}

function StateView({
  testID,
  title,
  body,
  onRetry,
}: {
  testID: string;
  title: string;
  body?: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID={testID}>
      <Text style={styles.stateTitle}>{title}</Text>
      {body ? <Text style={styles.stateBody}>{body}</Text> : null}
      {onRetry ? (
        <Button size="sm" variant="secondary" onPress={onRetry} testID={`${testID}-retry`}>
          {t("common.actions.retry")}
        </Button>
      ) : null}
    </View>
  );
}

function CreateNoteButton({ label, onCreateNote }: { label: string; onCreateNote?: () => void }) {
  if (!isWeb || !onCreateNote) return null;
  return (
    <Button size="sm" variant="secondary" onPress={onCreateNote} testID="new-note">
      {label}
    </Button>
  );
}

export function NotesPane({
  serverId,
  workspaceId,
  onOpenNote,
  onCreateNote,
}: {
  serverId: string;
  workspaceId: string | null;
  onOpenNote: (target: NoteTarget) => void;
  onCreateNote?: () => void;
}) {
  const { t } = useTranslation();
  const { notes, hostErrors, supported, connectionStatus, isLoading, error, refetch } =
    useProjectNotes(serverId, workspaceId);

  if (isLoading && notes.length === 0) {
    return <StateView testID="notes-loading" title={t("common.states.loading")} />;
  }
  if (!supported && notes.length === 0) {
    return <StateView testID="notes-unsupported" title={t("panels.notes.hostTooOld")} />;
  }
  if (error && notes.length === 0) {
    return (
      <StateView
        testID="notes-error"
        title={t("panels.notes.loadFailed")}
        body={error.message}
        onRetry={refetch}
      />
    );
  }
  if (isLoading) {
    return <StateView testID="notes-loading" title={t("common.states.loading")} />;
  }
  if (notes.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.notice}>
          <HostErrorsNotice errors={hostErrors} />
        </View>
        <StateView
          testID={connectionStatus === "online" ? "notes-empty" : "notes-disconnected"}
          title={
            connectionStatus === "online"
              ? t("panels.notes.emptyTitle")
              : t("panels.notes.disconnected")
          }
          body={connectionStatus === "online" ? t("panels.notes.emptyDescription") : undefined}
        />
        <CreateNoteButton label={t("panels.notes.newNote")} onCreateNote={onCreateNote} />
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <View style={styles.notice}>
        <HostErrorsNotice errors={hostErrors} />
      </View>
      <View style={styles.toolbar}>
        <CreateNoteButton label={t("panels.notes.newNote")} onCreateNote={onCreateNote} />
      </View>
      <ScrollView style={styles.list} testID="notes-list">
        {groupFederatedNotesByHost(notes).map((group) => (
          <Fragment key={group.serverId}>
            <Text style={styles.hostHeading} testID={`notes-host-${group.serverId}`}>
              {t("panels.notes.hostHeading", { host: group.serverName })}
            </Text>
            {group.notes.map((note) => (
              <NoteRow key={`${note.serverId}:${note.noteId}`} note={note} onOpen={onOpenNote} />
            ))}
          </Fragment>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  list: {
    flex: 1,
  },
  toolbar: {
    alignItems: "flex-end",
    padding: theme.spacing[2],
  },
  notice: {
    padding: theme.spacing[2],
  },
  hostHeading: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  row: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: 2,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowMeta: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  stateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  stateBody: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));
