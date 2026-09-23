import { useTranslation } from "react-i18next";

import { SegmentedControl } from "@/components/ui/segmented-control";
import type { TextFileView } from "@/file-panels/source/toolbar";

/** A note shows like a Markdown file: its rendered Preview or its Source. */
export type NoteView = TextFileView;

// Saving a draft replaces its tab with the saved note's, which mounts a new panel. The draft's view
// waits here for that panel so a writer stays in Source after the first save.
const createdNoteViews = new Map<string, NoteView>();

export function handOffNoteView(noteId: string, view: NoteView): void {
  createdNoteViews.set(noteId, view);
}

export function peekNoteView(noteId: string | null): NoteView | undefined {
  return noteId === null ? undefined : createdNoteViews.get(noteId);
}

export function clearNoteView(noteId: string | null): void {
  if (noteId !== null) createdNoteViews.delete(noteId);
}

export function NoteViewControl({
  view,
  onViewChange,
}: {
  view: NoteView;
  onViewChange: (view: NoteView) => void;
}) {
  const { t } = useTranslation();
  return (
    <SegmentedControl
      size="xs"
      value={view}
      onValueChange={onViewChange}
      testID="note-view-mode"
      options={[
        {
          value: "preview",
          label: t("panels.file.editor.preview"),
          testID: "note-mode-preview",
        },
        { value: "source", label: t("panels.file.editor.source"), testID: "note-mode-source" },
      ]}
    />
  );
}
