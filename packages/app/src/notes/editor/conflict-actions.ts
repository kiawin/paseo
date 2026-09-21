import type { RevisionedTextConflictCallout } from "@/editor/revisioned-text-model";

export type NoteConflictAction = "overwrite" | "reload" | "retry";

export function noteConflictActions(callout: RevisionedTextConflictCallout): NoteConflictAction[] {
  if (callout.kind === "changed") {
    return callout.canOverwrite ? ["overwrite", "reload"] : ["reload"];
  }
  return callout.kind === "checkFailed" ? ["retry"] : [];
}
