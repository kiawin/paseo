import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { editorBaseExtensions, editorTheme } from "@/file-panels/source/editor/extensions.web";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatTimeAgo } from "@/utils/time";
import { getRevisionedTextConflictCallout } from "@/editor/revisioned-text-model";
import { NoteConflictAlert } from "./conflict-alert";
import { noteDocumentMatches, serializeNoteDocument } from "./text";
import { NoteViewControl } from "./view-mode";
import type { NoteEditorViewProps } from "./view-types";

export function NoteEditorView({
  model,
  note,
  view,
  onViewChange,
  imageBehavior,
  remoteImageLoadLabel,
  theme,
  deleting,
  deleteError,
  onDelete,
  onRetry,
}: NoteEditorViewProps) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initial = useRef({ content: snapshot.content, model, theme });

  useEffect(() => {
    if (!hostRef.current) return;
    const values = initial.current;
    const editor = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: values.content,
        extensions: [
          ...editorBaseExtensions(() => void values.model.save()),
          // A note is Markdown prose, so its paragraphs wrap like a Markdown file's.
          EditorView.lineWrapping,
          themeCompartment.of(editorTheme(values.theme)),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) => transaction.annotation(remoteUpdate))
            ) {
              values.model.edit(
                serializeNoteDocument(update.state.doc, values.model.getSnapshot().lineSeparator),
              );
            }
          }),
        ],
      }),
    });
    viewRef.current = editor;
    return () => {
      editor.destroy();
      viewRef.current = null;
    };
  }, [model]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(editorTheme(theme)),
    });
  }, [theme]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) return;
    const document = editor.state.toText(snapshot.content);
    if (noteDocumentMatches(editor.state, snapshot.content)) return;
    const head = Math.min(editor.state.selection.main.head, document.length);
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: document },
      selection: { anchor: head },
      annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }, [snapshot.content]);

  let statusLabel: string | null = null;
  if (snapshot.status === "saving") {
    statusLabel = t("panels.notes.saving");
  } else if (snapshot.status === "error") {
    statusLabel = t("panels.notes.saveFailed");
  } else if (snapshot.status === "dirty") {
    statusLabel = t("panels.notes.unsavedChanges");
  }
  const handleReload = useCallback(() => {
    if (!snapshot.modified) {
      void model.reload();
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("panels.notes.reloadTitle"),
        message: t("panels.notes.reloadMessage"),
        confirmLabel: t("panels.notes.reload"),
        destructive: true,
      });
      if (confirmed) void model.reload();
    })();
  }, [model, snapshot.modified, t]);
  const handleOverwrite = useCallback(() => void model.overwrite(), [model]);
  const conflict = getRevisionedTextConflictCallout(snapshot);

  return (
    <View style={styles.container} testID="note-editor">
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text style={styles.title}>{note?.displayTitle ?? t("panels.notes.newNote")}</Text>
          {note ? (
            <Text style={styles.meta}>
              {t("panels.notes.updated", { time: formatTimeAgo(new Date(note.updatedAt)) })}
            </Text>
          ) : null}
        </View>
        <View style={styles.actions}>
          {statusLabel ? <Text style={styles.status}>{statusLabel}</Text> : null}
          <NoteViewControl view={view} onViewChange={onViewChange} />
          {onDelete ? (
            <Button variant="outline" size="sm" onPress={onDelete} loading={deleting}>
              {t("panels.notes.delete")}
            </Button>
          ) : null}
        </View>
      </View>
      {snapshot.replacedRevision !== null ? (
        <View style={styles.notice} testID="note-stale-write" accessibilityRole="alert">
          <Text style={styles.noticeTitle}>{t("panels.notes.staleWriteTitle")}</Text>
          <Text style={styles.noticeText}>
            {t("panels.notes.staleWriteDescription", {
              revision: snapshot.replacedRevision,
            })}
          </Text>
        </View>
      ) : null}
      <NoteConflictAlert
        callout={conflict}
        onReload={conflict?.kind === "changed" ? handleReload : undefined}
        onOverwrite={conflict?.kind === "changed" ? handleOverwrite : undefined}
        onRetry={onRetry}
      />
      {snapshot.error ? <Text style={styles.error}>{snapshot.error}</Text> : null}
      {deleteError ? (
        <Text style={styles.error} testID="note-delete-error" accessibilityRole="alert">
          {deleteError}
        </Text>
      ) : null}
      {view === "preview" ? (
        <ScrollView
          style={styles.preview}
          contentContainerStyle={styles.previewContent}
          testID="note-preview"
        >
          <MarkdownRenderer
            text={snapshot.content}
            remoteImageBehavior={imageBehavior}
            remoteImageLoadLabel={remoteImageLoadLabel}
          />
        </ScrollView>
      ) : null}
      {/* Hidden, not unmounted, on Preview: the editor keeps its undo history and selection. */}
      <View style={[styles.editorFrame, view === "preview" && styles.hidden]}>
        <div
          ref={hostRef}
          data-testid="note-source-editor"
          aria-label="Note editor"
          style={HOST_STYLE}
        />
      </View>
    </View>
  );
}

const remoteUpdate = Annotation.define<boolean>();
const themeCompartment = new Compartment();
// The host takes the frame's height so CodeMirror's own scroller scrolls the note. Sticky keeps
// CodeMirror's scrollIntoView inside the editor, as in the file editor.
const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden", position: "sticky" } as const;

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  header: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  heading: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "600" },
  meta: { color: theme.colors.mutedForeground, fontSize: theme.fontSize.xs },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  status: { color: theme.colors.mutedForeground, fontSize: theme.fontSize.xs },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.palette.amber[500],
    backgroundColor: theme.colors.surface1,
  },
  noticeTitle: { color: theme.colors.palette.amber[500], fontSize: theme.fontSize.sm },
  noticeText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flex: 1 },
  error: {
    color: theme.colors.palette.red[500],
    padding: theme.spacing[3],
    fontSize: theme.fontSize.sm,
  },
  preview: { flex: 1, minHeight: 0 },
  previewContent: { padding: theme.spacing[4] },
  editorFrame: { flex: 1, minHeight: 0, minWidth: 0 },
  hidden: { display: "none" },
}));
