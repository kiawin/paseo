import type pino from "pino";

import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  NoteChangedMessage,
  NoteDeleteRequest,
  NoteListRequest,
  NoteReadRequest,
  NoteRecordPayload,
  NoteSaveRequest,
  SessionOutboundMessage,
} from "../../messages.js";
import {
  NoteError,
  type NoteChange,
  type NoteStore,
  type PersistedNoteRecord,
} from "../../note-store.js";

export interface NotesSessionHost {
  emit(message: SessionOutboundMessage, source?: object): void;
  emitChanged(message: NoteChangedMessage, source: object): void;
}

export function toNoteRecordPayload(record: PersistedNoteRecord): NoteRecordPayload {
  return {
    noteId: record.noteId,
    projectId: record.projectId,
    displayTitle: record.displayTitle,
    size: record.size,
    contentSha256: record.contentSha256,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
  };
}

export class NotesSession {
  private readonly logger: pino.Logger;
  /**
   * Sockets that have asked for note metadata or content.
   *
   * `note.changed` is a discriminator a client from before this feature does not know, and its
   * outbound validator rejects the whole message and logs a protocol failure. A list or read is
   * the proof that a client has a Notes surface worth invalidating; event-subscription and
   * capability checks happen in the owning Session before this host emits it.
   */
  private readonly listeningSources = new Set<object>();

  constructor(
    private readonly host: NotesSessionHost,
    private readonly store: NoteStore | null,
    logger: pino.Logger,
  ) {
    this.logger = logger.child({ module: "notes-session" });
  }

  dispose(): void {
    this.listeningSources.clear();
  }

  async handleListRequest(request: NoteListRequest, source?: object): Promise<void> {
    const { projectId, requestId } = request;
    if (source) this.listeningSources.add(source);
    try {
      const records = await this.requireStore().listForProject(projectId);
      this.host.emit(
        {
          type: "note.list.response",
          payload: {
            projectId,
            notes: records.map(toNoteRecordPayload),
            success: true,
            error: null,
            requestId,
          },
        },
        source,
      );
    } catch (error) {
      this.host.emit(
        {
          type: "note.list.response",
          payload: {
            projectId,
            notes: [],
            success: false,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  async handleReadRequest(request: NoteReadRequest, source?: object): Promise<void> {
    const { noteId, projectId, requestId } = request;
    if (source) this.listeningSources.add(source);
    try {
      const store = this.requireStore();
      const record = await store.get(noteId);
      if (!record || (projectId !== undefined && record.projectId !== projectId)) {
        throw new NoteError("note_not_found", `No note ${noteId}`);
      }
      const body = (await store.readContent(record)).toString("utf8");
      this.host.emit(
        {
          type: "note.read.response",
          payload: {
            note: toNoteRecordPayload(record),
            body,
            success: true,
            error: null,
            requestId,
          },
        },
        source,
      );
    } catch (error) {
      this.host.emit(
        {
          type: "note.read.response",
          payload: {
            note: null,
            body: null,
            success: false,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  async handleSaveRequest(request: NoteSaveRequest, source?: object): Promise<void> {
    const { projectId, noteId, body, requestId } = request;
    try {
      const result = await this.requireStore().save({ projectId, noteId, body });
      this.host.emit(
        {
          type: "note.save.response",
          payload: {
            note: toNoteRecordPayload(result.record),
            replacedRevision: result.replaced?.revision ?? null,
            success: true,
            error: null,
            requestId,
          },
        },
        source,
      );
    } catch (error) {
      this.host.emit(
        {
          type: "note.save.response",
          payload: {
            note: null,
            replacedRevision: null,
            success: false,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  async handleDeleteRequest(request: NoteDeleteRequest, source?: object): Promise<void> {
    const { noteId, expectedRevision, projectId, requestId } = request;
    try {
      const store = this.requireStore();
      const record = await store.get(noteId);
      if (!record || (projectId !== undefined && record.projectId !== projectId)) {
        throw new NoteError("note_not_found", `No note ${noteId}`);
      }
      await store.delete(noteId, expectedRevision);
      this.host.emit(
        {
          type: "note.delete.response",
          payload: {
            noteId,
            currentRevision: null,
            success: true,
            error: null,
            requestId,
          },
        },
        source,
      );
    } catch (error) {
      this.host.emit(
        {
          type: "note.delete.response",
          payload: {
            noteId,
            currentRevision: error instanceof NoteError ? (error.currentRevision ?? null) : null,
            success: false,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  cancelForSource(source: object): void {
    this.listeningSources.delete(source);
  }

  broadcastChanged(change: NoteChange): void {
    const message: NoteChangedMessage = {
      type: "note.changed",
      payload: change,
    };
    for (const source of this.listeningSources) {
      try {
        this.host.emitChanged(message, source);
      } catch (error) {
        this.logger.error({ err: error, ...change }, "Failed to emit note change");
      }
    }
  }

  private requireStore(): NoteStore {
    if (!this.store) throw new Error("This daemon does not support notes.");
    return this.store;
  }
}
