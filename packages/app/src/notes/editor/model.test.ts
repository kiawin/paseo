import { describe, expect, test } from "vitest";
import type { NoteRecordPayload } from "@getpaseo/protocol/messages";
import type { SaveNoteResult } from "@getpaseo/client/internal/daemon-client";
import { NoteEditorModel, type NoteEditorSession } from "./model";

class TestClock {
  private callback: (() => void) | null = null;

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.callback = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(): void {
    this.callback = null;
  }

  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

class NoteSession implements NoteEditorSession {
  writes: Array<{ body: string; noteId?: string }> = [];
  nextResult: SaveNoteResult;

  constructor(record: NoteRecordPayload, replacedRevision: number | null = null) {
    this.nextResult = { note: record, replacedRevision };
  }

  save(input: { body: string; noteId?: string }): Promise<SaveNoteResult> {
    this.writes.push(input);
    return Promise.resolve(this.nextResult);
  }
}

function note(noteId = "note-1", revision = 1, displayTitle = "Note"): NoteRecordPayload {
  return {
    noteId,
    projectId: "project-1",
    displayTitle,
    size: 3,
    contentSha256: `hash-${revision}`,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: `2026-09-21T00:00:0${revision}.000Z`,
    revision,
  };
}

function makeModel(input: { body?: string; revision?: number | null } = {}) {
  const initialNote = note("note-1", input.revision ?? 1);
  const session = new NoteSession(initialNote);
  const clock = new TestClock();
  const created: string[] = [];
  const model = new NoteEditorModel({
    body: input.body ?? "one",
    noteId: input.revision === null ? null : initialNote.noteId,
    revision: input.revision === undefined ? initialNote.revision : input.revision,
    session,
    clock,
    onCreated: (noteId) => created.push(noteId),
  });
  return { model, session, clock, created };
}

describe("NoteEditorModel", () => {
  test("creates a provisional note on first save and surfaces a replaced revision", async () => {
    const { model, session, created } = makeModel({ body: "", revision: null });
    session.nextResult = { note: note("minted-note", 2), replacedRevision: 1 };

    model.edit("new body");
    await model.save();

    expect(session.writes).toEqual([{ body: "new body" }]);
    expect(created).toEqual(["minted-note"]);
    expect(model.getSnapshot()).toMatchObject({
      status: "clean",
      content: "new body",
      replacedRevision: 1,
      version: { status: "ready", revision: 2 },
    });
  });

  test("replaces a clean editor but preserves a dirty editor when note.changed arrives", () => {
    const { model } = makeModel();
    model.receiveNoteObservation({ status: "ready", note: note("note-1", 2), body: "remote" });

    expect(model.getSnapshot()).toMatchObject({ status: "clean", content: "remote" });

    model.edit("local");
    model.receiveNoteObservation({ status: "ready", note: note("note-1", 3), body: "new remote" });

    expect(model.getSnapshot()).toMatchObject({
      status: "conflict",
      content: "local",
      observedVersion: { status: "ready", revision: 3 },
    });
  });

  test("preserves a dirty buffer when the current note disappears", () => {
    const { model } = makeModel();
    model.edit("local work");
    model.receiveNoteObservation({ status: "missing", revision: 1 });

    expect(model.getSnapshot()).toMatchObject({
      status: "conflict",
      content: "local work",
      observedVersion: { status: "missing", revision: 1 },
    });
  });

  test("overwrites a changed note when the writer chooses to keep the local buffer", async () => {
    const { model, session } = makeModel();
    model.edit("local work");
    model.receiveNoteObservation({ status: "ready", note: note("note-1", 2), body: "remote" });

    await model.overwrite();

    expect(session.writes).toEqual([{ body: "local work", noteId: "note-1" }]);
  });

  test("does not call an ordinary save stale when it replaces its own base revision", async () => {
    const { model, session } = makeModel();
    session.nextResult = { note: note("note-1", 2), replacedRevision: 1 };

    model.edit("saved locally");
    await model.save();

    expect(model.getSnapshot()).toMatchObject({ status: "clean", replacedRevision: null });
  });

  test("surfaces the revision replaced by a stale save", async () => {
    const { model, session } = makeModel();
    session.nextResult = { note: note("note-1", 3), replacedRevision: 2 };

    model.edit("saved over remote");
    await model.save();

    expect(model.getSnapshot()).toMatchObject({ status: "clean", replacedRevision: 2 });
  });

  test("keeps autosave debounced", async () => {
    const { model, session, clock } = makeModel();
    model.edit("two");
    expect(session.writes).toEqual([]);

    clock.fire();
    await Promise.resolve();

    expect(session.writes).toEqual([{ body: "two", noteId: "note-1" }]);
  });
});
