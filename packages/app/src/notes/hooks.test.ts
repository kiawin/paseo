import { describe, expect, it } from "vitest";

import { noteQueryKey, notesQueryKey } from "./query-keys";
import { noteReadInput } from "./read";

describe("notes query keys", () => {
  it("uses only the note identity in each key", () => {
    expect(notesQueryKey("host-a", "project-1")).toEqual(["notes", "host-a", "project-1"]);
    expect(noteQueryKey("host-a", "note-1", "project-1")).toEqual([
      "notes",
      "record",
      "host-a",
      "note-1",
      "project-1",
    ]);
  });

  it("separates hosts that expose the same project and note id", () => {
    expect(notesQueryKey("host-a", "project-1")).not.toEqual(notesQueryKey("host-b", "project-1"));
    expect(noteQueryKey("host-a", "note-1", "project-1")).not.toEqual(
      noteQueryKey("host-b", "note-1", "project-1"),
    );
  });

  it("keeps gate inputs out of the cache identity", () => {
    expect(notesQueryKey("host-a", "project-1")).toEqual(notesQueryKey("host-a", "project-1"));
  });
});

describe("note reads", () => {
  it("falls back to an id-only read when the workspace project is unavailable", () => {
    expect(noteReadInput("note-1", null)).toEqual({ noteId: "note-1" });
    expect(noteReadInput("note-1", "project-1")).toEqual({
      noteId: "note-1",
      projectId: "project-1",
    });
  });
});
