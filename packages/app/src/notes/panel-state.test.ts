import { describe, expect, it } from "vitest";

import { NoteEditorModel } from "./editor/model";
import { notePanelObservationForState } from "./panel-state";

const note = {
  noteId: "note-1",
  projectId: "project-1",
  displayTitle: "Note",
  size: 4,
  contentSha256: "hash",
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
  revision: 3,
};

describe("note panel observations", () => {
  it("passes ready reads into the mounted editor model", () => {
    expect(
      notePanelObservationForState({
        state: "ready",
        note,
        body: "body",
        errorMessage: null,
      }),
    ).toEqual({ status: "ready", note, body: "body" });
  });

  it("turns a remote delete into a preserved missing observation", () => {
    expect(
      notePanelObservationForState({
        state: "error",
        note,
        body: "local buffer",
        errorMessage: "No note note-1",
      }),
    ).toEqual({ status: "missing", revision: 3 });
  });

  it("turns a disconnect into an error observation instead of replacing the editor", () => {
    expect(
      notePanelObservationForState({
        state: "disconnected",
        note,
        body: "local buffer",
        errorMessage: "Host is disconnected",
      }),
    ).toEqual({ status: "error", revision: 3, error: "Host is disconnected" });
  });

  it("preserves an unsaved draft through an online-disconnected-online transition", async () => {
    const model = new NoteEditorModel({
      body: "",
      noteId: null,
      revision: null,
      session: {
        save: async () => ({ note, replacedRevision: null }),
      },
    });
    model.edit("first paragraph\n\nsecond paragraph");

    for (const state of ["disconnected", "ready"] as const) {
      const observation = notePanelObservationForState({
        state,
        note: null,
        body: "",
        errorMessage: state === "disconnected" ? "Host is disconnected" : null,
        isDraft: true,
      });
      if (observation) model.receiveNoteObservation(observation);
    }

    expect(model.getSnapshot()).toMatchObject({
      status: "dirty",
      content: "first paragraph\n\nsecond paragraph",
    });

    await model.save();

    expect(model.getSnapshot()).toMatchObject({ status: "clean" });
    model.dispose();
  });
});
