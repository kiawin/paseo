import type { EditorState, Text } from "@codemirror/state";

import type { RevisionedTextLineSeparator } from "@/editor/revisioned-text-model";

export function serializeNoteDocument(
  document: Text,
  lineSeparator: RevisionedTextLineSeparator,
): string {
  return document.sliceString(0, undefined, lineSeparator);
}

export function noteDocumentMatches(state: EditorState, content: string): boolean {
  return state.doc.eq(state.toText(content));
}
