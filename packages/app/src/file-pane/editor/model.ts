import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import {
  getRevisionedTextConflictCallout,
  RevisionedTextModel,
  type RevisionedTextAdapter,
  type RevisionedTextClock,
  type RevisionedTextConflictCallout,
  type RevisionedTextObservation,
  type RevisionedTextSnapshot,
  type RevisionedTextStatus,
} from "@/editor/revisioned-text-model";

export type FileEditorStatus = RevisionedTextStatus;
export type FileEditorClock = RevisionedTextClock;
export type FileLineSeparator = "\n" | "\r\n" | "\r";

export type FileEditorSnapshot = RevisionedTextSnapshot<FileVersion, string | null>;

export type FileConflictCallout = RevisionedTextConflictCallout;

export interface FileEditorFile {
  content: string;
  hasBom: boolean;
  version: Extract<FileVersion, { status: "ready" }>;
}

export interface FileEditorSession {
  write(input: {
    content: string;
    expectedModifiedAt: string;
    expectedRevision?: string;
  }): Promise<FileWriteResult>;
}

export type FileEditorObservation =
  | { status: "ready"; file: FileEditorFile }
  | Extract<FileVersion, { status: "missing" | "error" }>;

export interface FileObservationSource {
  subscribe(listener: () => void): () => void;
  getObservation(): FileEditorObservation | null;
  refresh(): void;
}

type FileEditorAdapter = RevisionedTextAdapter<
  FileVersion,
  FileEditorObservation,
  FileWriteResult,
  boolean,
  string | null
>;

function createFileEditorAdapter(input: {
  file: FileEditorFile;
  session: FileEditorSession;
}): FileEditorAdapter {
  return {
    initial: {
      content: input.file.content,
      format: input.file.hasBom,
      version: input.file.version,
    },
    observe(observation): RevisionedTextObservation<FileVersion, boolean> {
      if (observation.status === "ready") {
        return {
          status: "ready",
          document: {
            content: observation.file.content,
            format: observation.file.hasBom,
            version: observation.file.version,
          },
        };
      }
      return observation.status === "missing"
        ? { status: "missing", version: observation }
        : { status: "error", version: observation, error: observation.error };
    },
    write: ({ content, format, expectedVersion }) =>
      input.session.write({
        content: format ? `\uFEFF${content}` : content,
        expectedModifiedAt: expectedVersion.status === "ready" ? expectedVersion.modifiedAt : "",
        expectedRevision: expectedVersion.status === "ready" ? expectedVersion.revision : undefined,
      }),
    resolveWrite(result, expectedVersion) {
      if (result.status === "error") {
        return { status: "error", error: result.error };
      }
      if (result.status === "conflict") {
        return { status: "conflict", version: result.version };
      }
      if (expectedVersion.status !== "ready") {
        return { status: "error", error: "The file version is not ready." };
      }
      return {
        status: "written",
        version: {
          status: "ready",
          cwd: expectedVersion.cwd,
          path: expectedVersion.path,
          size: result.size,
          modifiedAt: result.modifiedAt,
          revision: result.revision,
        },
        replacedRevision: null,
      };
    },
    documentsEqual(left, right) {
      return left.content === right.content && left.format === right.format;
    },
  };
}

export class FileEditorModel extends RevisionedTextModel<
  FileVersion,
  FileEditorObservation,
  FileWriteResult,
  boolean,
  string | null
> {
  constructor(input: {
    file: FileEditorFile;
    session: FileEditorSession;
    clock?: RevisionedTextClock;
  }) {
    super({
      adapter: createFileEditorAdapter(input),
      clock: input.clock,
    });
  }

  connectFileObservations(source: FileObservationSource): void {
    this.connectObservations(source);
  }

  disconnectFileObservations(): void {
    this.disconnectObservations();
  }

  receiveFileObservation(observation: FileEditorObservation): void {
    this.receiveObservation(observation);
  }
}

export function getFileConflictCallout(snapshot: FileEditorSnapshot): FileConflictCallout | null {
  return getRevisionedTextConflictCallout(snapshot);
}
