import { useCallback } from "react";
import { FileText } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";

import { NotesPane } from "@/notes/pane";
import type { NoteTarget } from "@/notes/federation";
import { generateMessageId } from "@/types/stream";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";

const ThemedFileText = withUnistyles(FileText);

export const notesPanelPresentation = {
  label: (t) => t("panels.notes.label"),
  subtitle: (t) => t("panels.notes.subtitle"),
  tooltip: (t) => t("panels.notes.tooltip"),
  icon: ThemedFileText,
} satisfies PanelPresentation;

function NotesPanel() {
  const { serverId, workspaceId, target, openTab, openPreferredTarget } = usePaneContext();
  invariant(target.kind === "notes", "NotesPanel requires notes target");
  const onOpenNote = useCallback(
    (noteTarget: NoteTarget) => openPreferredTarget(noteTarget, "explorerFiles"),
    [openPreferredTarget],
  );
  const onCreateNote = useCallback(
    () =>
      openTab({
        kind: "note_draft",
        serverId,
        draftId: `note_${generateMessageId()}`,
      }),
    [openTab, serverId],
  );
  return (
    <NotesPane
      serverId={serverId}
      workspaceId={workspaceId}
      onOpenNote={onOpenNote}
      onCreateNote={onCreateNote}
    />
  );
}

export const notesPanelRegistration = definePanel("notes", {
  component: NotesPanel,
  presentation: notesPanelPresentation,
});
