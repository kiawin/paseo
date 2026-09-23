import type { NoteRecordPayload } from "@getpaseo/protocol/messages";

import type { NoteEditorObservation } from "./editor/model";

export type NotePanelLoadState = "loading" | "disconnected" | "unsupported" | "error" | "ready";

export function isNoteNotFoundError(error: Error | null): boolean {
  return error?.message.startsWith("No note ") ?? false;
}

export function notePanelObservationForState(input: {
  state: NotePanelLoadState;
  note: NoteRecordPayload | null;
  body: string | null;
  errorMessage: string | null;
  isDraft?: boolean;
}): NoteEditorObservation | null {
  if (input.isDraft) return null;
  if (input.state === "ready" && input.note && input.body !== null) {
    return { status: "ready", note: input.note, body: input.body };
  }
  if (input.state === "loading") return null;

  const revision = input.note?.revision ?? null;
  if (input.errorMessage && isNoteNotFoundError(new Error(input.errorMessage))) {
    return { status: "missing", revision };
  }
  return {
    status: "error",
    revision,
    error: input.errorMessage ?? "Notes host is unavailable.",
  };
}
