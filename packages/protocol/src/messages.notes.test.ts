import { describe, expect, test } from "vitest";

import {
  NoteChangedMessageSchema,
  NoteDeleteRequestSchema,
  NoteDeleteResponseSchema,
  NoteListRequestSchema,
  NoteListResponseSchema,
  NoteReadRequestSchema,
  NoteReadResponseSchema,
  NoteSaveRequestSchema,
  NoteSaveResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionEventSubscriptionSchema,
  SessionInboundMessageSchema,
  WSOutboundMessageSchema,
} from "./messages.js";

const RECORD = {
  noteId: "note_0123456789abcdef",
  projectId: "prj_notes",
  displayTitle: "Release notes",
  size: 24,
  contentSha256: "a".repeat(64),
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:01.000Z",
  revision: 2,
};

describe("note messages", () => {
  test("gates the feature and event subscription independently", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.notes,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: { notes: true },
      }).features?.notes,
    ).toBe(true);
    expect(SessionEventSubscriptionSchema.parse("note.changed")).toBe("note.changed");
  });

  test("accepts a create request without a note id", () => {
    const request = {
      type: "note.save.request" as const,
      projectId: RECORD.projectId,
      body: "# Release notes",
      requestId: "req-save",
    };
    expect(NoteSaveRequestSchema.parse(request)).toEqual(request);
  });

  test("round-trips list and read, including nullable failure fields", () => {
    const listRequest = {
      type: "note.list.request" as const,
      projectId: RECORD.projectId,
      requestId: "req-list",
    };
    expect(NoteListRequestSchema.parse(listRequest)).toEqual(listRequest);
    expect(
      NoteListResponseSchema.parse({
        type: "note.list.response",
        payload: {
          projectId: RECORD.projectId,
          notes: [{ ...RECORD, futureField: "ignored" }],
          success: true,
          error: null,
          requestId: "req-list",
        },
      }).payload.notes,
    ).toEqual([RECORD]);

    const readRequest = {
      type: "note.read.request" as const,
      projectId: RECORD.projectId,
      noteId: RECORD.noteId,
      requestId: "req-read",
    };
    expect(NoteReadRequestSchema.parse(readRequest)).toEqual(readRequest);
    expect(
      NoteReadResponseSchema.parse({
        type: "note.read.response",
        payload: { note: null, body: null, success: false, error: "gone", requestId: "req-read" },
      }).payload,
    ).toMatchObject({ note: null, body: null, success: false });
  });

  test("round-trips save and delete responses with revision reporting", () => {
    const save = {
      type: "note.save.response" as const,
      payload: {
        note: RECORD,
        replacedRevision: 1,
        success: true,
        error: null,
        requestId: "req-save",
      },
    };
    expect(NoteSaveResponseSchema.parse(save)).toEqual(save);

    const delRequest = {
      type: "note.delete.request" as const,
      noteId: RECORD.noteId,
      expectedRevision: RECORD.revision,
      requestId: "req-delete",
    };
    expect(NoteDeleteRequestSchema.parse(delRequest)).toEqual(delRequest);
    const delResponse = {
      type: "note.delete.response" as const,
      payload: {
        noteId: RECORD.noteId,
        currentRevision: RECORD.revision,
        success: false,
        error: "revision conflict",
        requestId: "req-delete",
      },
    };
    expect(NoteDeleteResponseSchema.parse(delResponse)).toEqual(delResponse);
  });

  test("carries project, note, revision, and change kind", () => {
    const changed = {
      type: "note.changed" as const,
      payload: {
        subscriptionId: "sub-1",
        projectId: RECORD.projectId,
        noteId: RECORD.noteId,
        revision: null,
        kind: "delete" as const,
      },
    };
    expect(NoteChangedMessageSchema.parse(changed)).toEqual(changed);
  });

  test("registers every note request and response in the unions", () => {
    for (const message of [
      { type: "note.list.request", projectId: RECORD.projectId, requestId: "r" },
      { type: "note.read.request", noteId: RECORD.noteId, requestId: "r" },
      { type: "note.save.request", projectId: RECORD.projectId, body: "body", requestId: "r" },
      {
        type: "note.delete.request",
        noteId: RECORD.noteId,
        expectedRevision: RECORD.revision,
        requestId: "r",
      },
    ]) {
      expect(SessionInboundMessageSchema.safeParse(message).success).toBe(true);
    }

    for (const message of [
      {
        type: "note.list.response",
        payload: {
          projectId: RECORD.projectId,
          notes: [],
          success: true,
          error: null,
          requestId: "r",
        },
      },
      {
        type: "note.read.response",
        payload: { note: RECORD, body: "body", success: true, error: null, requestId: "r" },
      },
      {
        type: "note.save.response",
        payload: {
          note: RECORD,
          replacedRevision: null,
          success: true,
          error: null,
          requestId: "r",
        },
      },
      {
        type: "note.delete.response",
        payload: {
          noteId: RECORD.noteId,
          currentRevision: null,
          success: true,
          error: null,
          requestId: "r",
        },
      },
      {
        type: "note.changed",
        payload: {
          projectId: RECORD.projectId,
          noteId: RECORD.noteId,
          revision: RECORD.revision,
          kind: "update",
        },
      },
    ]) {
      expect(WSOutboundMessageSchema.safeParse({ type: "session", message }).success).toBe(true);
    }
  });
});
