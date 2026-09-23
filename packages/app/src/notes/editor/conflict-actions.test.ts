import { describe, expect, it } from "vitest";

import { noteConflictActions } from "./conflict-actions";

describe("note conflict actions", () => {
  it("offers overwrite alongside reload for a dirty changed note", () => {
    expect(noteConflictActions({ kind: "changed", canOverwrite: true })).toEqual([
      "overwrite",
      "reload",
    ]);
  });

  it("does not offer destructive overwrite for a clean changed note", () => {
    expect(noteConflictActions({ kind: "changed", canOverwrite: false })).toEqual(["reload"]);
  });
});
