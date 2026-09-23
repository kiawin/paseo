import type { NoteRecordPayload } from "@getpaseo/protocol/messages";
import type { SaveNoteResult } from "@getpaseo/client/internal/daemon-client";
import {
  RevisionedTextModel,
  type RevisionedTextAdapter,
  type RevisionedTextClock,
  type RevisionedTextObservation,
} from "@/editor/revisioned-text-model";

export type NoteEditorVersion =
  | { status: "ready"; revision: number | null }
  | { status: "missing"; revision: number | null }
  | { status: "error"; revision: number | null; error: string };

export type NoteEditorObservation =
  | { status: "ready"; note: NoteRecordPayload; body: string }
  | { status: "missing"; revision: number | null }
  | { status: "error"; revision: number | null; error: string };

export interface NoteEditorSession {
  save(input: { body: string; noteId?: string }): Promise<SaveNoteResult>;
}

interface NoteEditorAdapter extends RevisionedTextAdapter<
  NoteEditorVersion,
  NoteEditorObservation,
  SaveNoteResult,
  null,
  number
> {}

function createNoteEditorAdapter(input: {
  body: string;
  noteId: string | null;
  revision: number | null;
  session: NoteEditorSession;
  onCreated?: (noteId: string) => void;
}): NoteEditorAdapter {
  let noteId = input.noteId;
  return {
    initial: {
      content: input.body,
      format: null,
      version: { status: "ready", revision: input.revision },
    },
    observe(observation): RevisionedTextObservation<NoteEditorVersion, null> {
      if (observation.status === "ready") {
        return {
          status: "ready",
          document: {
            content: observation.body,
            format: null,
            version: { status: "ready", revision: observation.note.revision },
          },
        };
      }
      if (observation.status === "missing") {
        return {
          status: "missing",
          version: { status: "missing", revision: observation.revision },
        };
      }
      return {
        status: "error",
        version: { status: "error", revision: observation.revision, error: observation.error },
        error: observation.error,
      };
    },
    write: ({ content }) => input.session.save({ body: content, ...(noteId ? { noteId } : {}) }),
    resolveWrite(result, expectedVersion) {
      if (!noteId) {
        noteId = result.note.noteId;
        input.onCreated?.(noteId);
      }
      return {
        status: "written",
        version: { status: "ready", revision: result.note.revision },
        replacedRevision:
          result.replacedRevision === expectedVersion.revision ? null : result.replacedRevision,
      };
    },
    documentsEqual(left, right) {
      return left.content === right.content;
    },
  };
}

export class NoteEditorModel extends RevisionedTextModel<
  NoteEditorVersion,
  NoteEditorObservation,
  SaveNoteResult,
  null,
  number
> {
  constructor(input: {
    body: string;
    noteId: string | null;
    revision: number | null;
    session: NoteEditorSession;
    onCreated?: (noteId: string) => void;
    clock?: RevisionedTextClock;
  }) {
    super({
      adapter: createNoteEditorAdapter(input),
      clock: input.clock,
    });
  }

  receiveNoteObservation(observation: NoteEditorObservation): void {
    this.receiveObservation(observation);
  }

  getCurrentRevision(): number | null {
    return this.getSnapshot().observedVersion.revision;
  }
}
