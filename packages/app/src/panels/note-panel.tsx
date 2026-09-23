import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react-native";
import { StyleSheet, UnistylesRuntime, withUnistyles } from "react-native-unistyles";
import { Text, View } from "react-native";
import invariant from "tiny-invariant";
import { NoteDeleteError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { NoteRecordPayload } from "@getpaseo/protocol/messages";

import { isWeb } from "@/constants/platform";
import { useSettings } from "@/hooks/use-settings";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { useWorkspaceProjectId } from "@/artifacts/hooks";
import { useNote, useProjectNoteHost } from "@/notes/hooks";
import { NoteEditorModel, type NoteEditorSession } from "@/notes/editor/model";
import { NoteEditorView } from "@/notes/editor/view";
import { notePanelObservationForState, type NotePanelLoadState } from "@/notes/panel-state";
import { usePaneContext } from "@/panels/pane-context";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { definePanel } from "@/panels/panel-registry";
import { buildNotePanelDescriptor } from "@/panels/note-panel-descriptor";

const ThemedFileText = withUnistyles(FileText);

function useNotePanelDescriptor(
  target:
    | { kind: "note"; serverId: string; noteId: string }
    | { kind: "note_draft"; serverId: string; draftId: string },
  _context: { serverId: string },
) {
  const { t } = useTranslation();
  const noteTarget = target.kind === "note" ? target : null;
  const { note } = useNote(noteTarget?.serverId ?? "", null, noteTarget?.noteId ?? "");
  return buildNotePanelDescriptor({
    record: note,
    fallbackLabel: t("panels.notes.label"),
    subtitle: t("panels.notes.subtitle"),
    tooltip: t("panels.notes.tooltip"),
    icon: ThemedFileText,
  });
}

function NoteStateView({
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

function NotePanel() {
  const { target } = usePaneContext();
  invariant(
    target.kind === "note" || target.kind === "note_draft",
    "NotePanel requires a note target",
  );
  if (target.kind === "note") {
    return <SavedNotePanel serverId={target.serverId} noteId={target.noteId} />;
  }
  return <DraftNotePanel serverId={target.serverId} />;
}

function SavedNotePanel({ serverId, noteId }: { serverId: string; noteId: string }) {
  const { serverId: workspaceServerId, workspaceId } = usePaneContext();
  const imageBehavior = useSettings((settings) => settings.noteImageBehavior);
  const noteHost = useProjectNoteHost(workspaceServerId, workspaceId, serverId);
  const projectId = noteHost?.projectId ?? null;
  const { note, body, supported, connectionStatus, isLoading, error, refetch } = useNote(
    serverId,
    projectId,
    noteId,
  );

  let loadState: NotePanelLoadState;
  if (connectionStatus !== "online") loadState = isLoading ? "loading" : "disconnected";
  else if (!supported) loadState = "unsupported";
  else if (error) loadState = "error";
  else if (isLoading || !note || body === null) loadState = "loading";
  else loadState = "ready";

  return (
    <LoadedNoteEditor
      serverId={serverId}
      workspaceId={workspaceId}
      projectId={projectId}
      initialNoteId={noteId}
      note={note}
      body={body}
      loadState={loadState}
      errorMessage={error?.message ?? null}
      onRetry={refetch}
      imageBehavior={imageBehavior}
    />
  );
}

function DraftNotePanel({ serverId }: { serverId: string }) {
  const { workspaceId, convertCurrentTabToNote } = usePaneContext();
  const projectId = useWorkspaceProjectId(serverId, workspaceId);
  const supported = useHostFeature(serverId, "notes");
  const connectionStatus = useHostRuntimeConnectionStatus(serverId);
  const client = useHostRuntimeClient(serverId);
  const imageBehavior = useSettings((settings) => settings.noteImageBehavior);

  let loadState: NotePanelLoadState;
  if (connectionStatus !== "online") {
    loadState =
      connectionStatus === "connecting" || connectionStatus === "idle" ? "loading" : "disconnected";
  } else if (!supported) loadState = "unsupported";
  else if (!projectId || !client) loadState = "loading";
  else loadState = "ready";

  return (
    <LoadedNoteEditor
      serverId={serverId}
      workspaceId={workspaceId}
      projectId={projectId}
      initialNoteId={null}
      note={null}
      body=""
      loadState={loadState}
      errorMessage={null}
      imageBehavior={imageBehavior}
      onCreated={convertCurrentTabToNote}
    />
  );
}

function LoadedNoteEditor({
  serverId,
  workspaceId,
  projectId: explicitProjectId,
  initialNoteId,
  note,
  body,
  loadState,
  errorMessage,
  onRetry,
  imageBehavior,
  onCreated,
}: {
  serverId: string;
  workspaceId: string;
  projectId?: string | null;
  initialNoteId: string | null;
  note: NoteRecordPayload | null;
  body: string | null;
  loadState: NotePanelLoadState;
  errorMessage: string | null;
  onRetry?: () => void;
  imageBehavior: "auto" | "tap-to-load" | "disabled";
  onCreated?: (noteId: string) => void;
}) {
  const { t } = useTranslation();
  const { closeCurrentTab } = usePaneContext();
  const isDraft = initialNoteId === null;
  const projectIdFromWorkspace = useWorkspaceProjectId(serverId, workspaceId);
  const [lastNote, setLastNote] = useState<NoteRecordPayload | null>(note);
  const displayNote = note ?? lastNote;
  const projectId = explicitProjectId ?? displayNote?.projectId ?? projectIdFromWorkspace;
  const client = useHostRuntimeClient(serverId);
  const clientRef = useRef<DaemonClient | null>(client);
  const projectIdRef = useRef<string | null>(projectId);
  clientRef.current = client;
  projectIdRef.current = projectId;
  const session = useMemo<NoteEditorSession>(
    () => ({
      save: (input) => {
        const currentClient = clientRef.current;
        const currentProjectId = projectIdRef.current;
        if (!currentClient || !currentProjectId) throw new Error("Notes host is not ready.");
        return currentClient.saveNote({ projectId: currentProjectId, ...input });
      },
    }),
    [],
  );
  const [model] = useState(
    () =>
      new NoteEditorModel({
        body: body ?? "",
        noteId: note?.noteId ?? initialNoteId,
        revision: note?.revision ?? null,
        session,
        onCreated,
      }),
  );
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [hasLoadedDocument, setHasLoadedDocument] = useState(loadState === "ready");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (note) setLastNote(note);
    const observation = notePanelObservationForState({
      state: loadState,
      note: note ?? lastNote,
      body,
      errorMessage,
      isDraft,
    });
    if (isDraft && loadState === "ready") setHasLoadedDocument(true);
    if (!observation) return;
    if (observation.status === "ready") setHasLoadedDocument(true);
    model.receiveNoteObservation(observation);
  }, [body, errorMessage, isDraft, lastNote, loadState, model, note]);
  useEffect(() => () => model.dispose(), [model]);

  const suspendPendingSave = useCallback(() => model.suspendAutosave(), [model]);
  usePublishPanelInstanceAttributes({ modified: snapshot.modified, suspendPendingSave });

  const handleDelete = useCallback(async () => {
    if (!displayNote || !projectId || !client) return;
    const expectedRevision = model.getCurrentRevision();
    if (expectedRevision === null) return;
    const confirmed = await confirmDialog({
      title: t("panels.notes.deleteTitle"),
      message: t("panels.notes.deleteMessage", { title: displayNote.displayTitle }),
      confirmLabel: t("panels.notes.deleteConfirm"),
      destructive: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await client.deleteNote({ noteId: displayNote.noteId, projectId, expectedRevision });
      closeCurrentTab();
    } catch (error) {
      if (error instanceof NoteDeleteError && error.currentRevision !== null) {
        setDeleteError(t("panels.notes.deleteConflict", { revision: error.currentRevision }));
      } else {
        setDeleteError(t("panels.notes.deleteFailed"));
      }
    } finally {
      setDeleting(false);
    }
  }, [client, closeCurrentTab, displayNote, model, projectId, t]);

  const theme = UnistylesRuntime.getTheme();
  const visualTheme = useMemo(
    () => ({
      colorScheme: theme.colorScheme,
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      cursor: theme.colors.terminal.cursor,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
      syntax: theme.colors.syntax,
    }),
    [
      theme.colors.border,
      theme.colors.foreground,
      theme.colors.foregroundMuted,
      theme.colors.surface0,
      theme.colors.syntax,
      theme.colors.terminal.cursor,
      theme.colors.terminal.selectionBackground,
      theme.colorScheme,
      theme.fontFamily.mono,
      theme.fontSize.code,
    ],
  );

  if (!hasLoadedDocument) {
    if (loadState === "error") {
      return (
        <NoteStateView
          testID="note-error"
          title={t("panels.notes.loadFailed")}
          body={errorMessage ?? undefined}
          onRetry={onRetry}
        />
      );
    }
    if (loadState === "unsupported") {
      return <NoteStateView testID="note-unsupported" title={t("panels.notes.hostTooOld")} />;
    }
    if (loadState === "disconnected") {
      return <NoteStateView testID="note-disconnected" title={t("panels.notes.disconnected")} />;
    }
    return <NoteStateView testID="note-loading" title={t("common.states.loading")} />;
  }

  return (
    <NoteEditorView
      model={model}
      note={displayNote}
      body={snapshot.content}
      imageBehavior={imageBehavior}
      remoteImageLoadLabel={t("panels.notes.loadImage")}
      theme={visualTheme}
      deleting={deleting}
      deleteError={deleteError}
      onDelete={isWeb && displayNote ? handleDelete : undefined}
      onRetry={onRetry}
    />
  );
}

export const notePanelRegistration = definePanel("note", {
  component: NotePanel,
  useDescriptor: useNotePanelDescriptor,
});

export const noteDraftPanelRegistration = definePanel("note_draft", {
  component: NotePanel,
  useDescriptor: useNotePanelDescriptor,
});

const styles = StyleSheet.create((theme) => ({
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  stateTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, textAlign: "center" },
  stateBody: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));
