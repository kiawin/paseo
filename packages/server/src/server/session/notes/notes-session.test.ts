import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { SessionOutboundMessage } from "../../messages.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { NoteStore } from "../../note-store.js";
import { NotesSession } from "./notes-session.js";

let root: string;
let store: NoteStore;

function makeSession() {
  const emitted: Array<{ message: SessionOutboundMessage; source?: object }> = [];
  const session = new NotesSession(
    {
      emit: (message, source) => emitted.push({ message, source }),
      emitChanged: (message, source) => emitted.push({ message, source }),
    },
    store,
    createTestLogger(),
  );
  return { session, emitted };
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "notes-session-"));
  store = new NoteStore(root, createTestLogger());
  await store.initialize();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("note RPC handlers", () => {
  test("lists project metadata without note bodies", async () => {
    const saved = await store.save({ projectId: "prj_notes", body: "# One" });
    const { session, emitted } = makeSession();

    await session.handleListRequest(
      { type: "note.list.request", projectId: "prj_notes", requestId: "list-1" },
      {},
    );

    expect(emitted[0]?.message).toEqual({
      type: "note.list.response",
      payload: {
        projectId: "prj_notes",
        notes: [expect.objectContaining({ noteId: saved.record.noteId, displayTitle: "One" })],
        success: true,
        error: null,
        requestId: "list-1",
      },
    });
    expect(JSON.stringify(emitted[0])).not.toContain("# One");
  });

  test("reads a note body using the record's project", async () => {
    const saved = await store.save({ projectId: "prj_notes", body: "# Body" });
    const { session, emitted } = makeSession();

    await session.handleReadRequest(
      {
        type: "note.read.request",
        projectId: "prj_notes",
        noteId: saved.record.noteId,
        requestId: "read-1",
      },
      {},
    );

    expect(emitted[0]?.message).toEqual({
      type: "note.read.response",
      payload: {
        note: expect.objectContaining({ noteId: saved.record.noteId }),
        body: "# Body",
        success: true,
        error: null,
        requestId: "read-1",
      },
    });
  });

  test("saves a new note and returns the minted record", async () => {
    const { session, emitted } = makeSession();

    await session.handleSaveRequest(
      { type: "note.save.request", projectId: "prj_notes", body: "# New", requestId: "save-1" },
      {},
    );

    const response = emitted[0]?.message;
    expect(response).toMatchObject({
      type: "note.save.response",
      payload: {
        note: { projectId: "prj_notes", displayTitle: "New", revision: 1 },
        replacedRevision: null,
        success: true,
        requestId: "save-1",
      },
    });
  });

  test("saves an update and reports the replaced revision", async () => {
    const saved = await store.save({ projectId: "prj_notes", body: "old" });
    const { session, emitted } = makeSession();

    await session.handleSaveRequest(
      {
        type: "note.save.request",
        projectId: "prj_notes",
        noteId: saved.record.noteId,
        body: "new",
        requestId: "save-2",
      },
      {},
    );

    expect(emitted[0]?.message).toMatchObject({
      type: "note.save.response",
      payload: { note: { revision: 2 }, replacedRevision: 1, success: true },
    });
  });

  test("surfaces the current revision for a delete conflict", async () => {
    const saved = await store.save({ projectId: "prj_notes", body: "old" });
    await store.save({ projectId: "prj_notes", noteId: saved.record.noteId, body: "new" });
    const { session, emitted } = makeSession();

    await session.handleDeleteRequest(
      {
        type: "note.delete.request",
        noteId: saved.record.noteId,
        expectedRevision: 1,
        requestId: "delete-1",
      },
      {},
    );

    expect(emitted[0]?.message).toEqual({
      type: "note.delete.response",
      payload: {
        noteId: saved.record.noteId,
        currentRevision: 2,
        success: false,
        error: expect.stringContaining("revision"),
        requestId: "delete-1",
      },
    });
  });
});

test("only list/read sockets receive note.changed", async () => {
  const saved = await store.save({ projectId: "prj_notes", body: "body" });
  const { session, emitted } = makeSession();
  const listed = {};
  const read = {};
  const bystander = {};

  await session.handleListRequest(
    { type: "note.list.request", projectId: "prj_notes", requestId: "list-2" },
    listed,
  );
  await session.handleReadRequest(
    { type: "note.read.request", noteId: saved.record.noteId, requestId: "read-2" },
    read,
  );
  emitted.length = 0;

  session.broadcastChanged({
    projectId: "prj_notes",
    noteId: saved.record.noteId,
    revision: 2,
    kind: "update",
  });

  expect(emitted.map((entry) => entry.source)).toEqual([listed, read]);
  expect(emitted.every((entry) => entry.message.type === "note.changed")).toBe(true);
  expect(emitted.some((entry) => entry.source === bystander)).toBe(false);
});

describe("pin and search", () => {
  test("pins a note in its own project and reports the pinned record", async () => {
    const saved = await store.save({ projectId: "prj_notes", body: "# One" });
    const { session, emitted } = makeSession();

    await session.handlePinSetRequest(
      {
        type: "note.pin.set.request",
        noteId: saved.record.noteId,
        projectId: "prj_notes",
        pinned: true,
        requestId: "pin-1",
      },
      {},
    );

    expect(emitted[0]?.message).toEqual({
      type: "note.pin.set.response",
      payload: {
        note: expect.objectContaining({ noteId: saved.record.noteId, pinned: true, revision: 1 }),
        success: true,
        error: null,
        requestId: "pin-1",
      },
    });
  });

  test("refuses to pin a note through another project", async () => {
    const saved = await store.save({ projectId: "prj_notes", body: "# One" });
    const { session, emitted } = makeSession();

    await session.handlePinSetRequest(
      {
        type: "note.pin.set.request",
        noteId: saved.record.noteId,
        projectId: "prj_other",
        pinned: true,
        requestId: "pin-2",
      },
      {},
    );

    expect(emitted[0]?.message).toMatchObject({
      type: "note.pin.set.response",
      payload: { note: null, success: false, requestId: "pin-2" },
    });
    expect(await store.get(saved.record.noteId)).not.toHaveProperty("pinned");
  });

  test("archives a note in its own project and refuses one through another project", async () => {
    const saved = await store.save({ projectId: "prj_notes", body: "# One" });
    const { session, emitted } = makeSession();

    await session.handleArchiveSetRequest(
      {
        type: "note.archive.set.request",
        noteId: saved.record.noteId,
        projectId: "prj_other",
        archived: true,
        requestId: "archive-1",
      },
      {},
    );
    await session.handleArchiveSetRequest(
      {
        type: "note.archive.set.request",
        noteId: saved.record.noteId,
        projectId: "prj_notes",
        archived: true,
        requestId: "archive-2",
      },
      {},
    );

    expect(emitted[0]?.message).toMatchObject({
      type: "note.archive.set.response",
      payload: { note: null, success: false, requestId: "archive-1" },
    });
    expect(emitted[1]?.message).toEqual({
      type: "note.archive.set.response",
      payload: {
        note: expect.objectContaining({ noteId: saved.record.noteId, archived: true }),
        success: true,
        error: null,
        requestId: "archive-2",
      },
    });
  });

  test("searches the project's notes", async () => {
    const saved = await store.save({
      projectId: "prj_notes",
      body: "# One\n\nThe launch checklist",
    });
    const { session, emitted } = makeSession();

    await session.handleSearchRequest(
      { type: "note.search.request", projectId: "prj_notes", query: "launch", requestId: "s-1" },
      {},
    );

    expect(emitted[0]?.message).toEqual({
      type: "note.search.response",
      payload: {
        projectId: "prj_notes",
        matches: [{ noteId: saved.record.noteId, snippet: "# One The launch checklist" }],
        success: true,
        error: null,
        requestId: "s-1",
      },
    });
  });
});
