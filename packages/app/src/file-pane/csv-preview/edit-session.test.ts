import { describe, expect, it } from "vitest";
import {
  createCsvEditSessionState,
  csvEditSessionReducer,
  undoableCsvPatch,
  type CsvEditSessionAction,
} from "./edit-session";

const firstPatch = { offset: 4, removed: "1", inserted: "one" };
const secondPatch = { offset: 8, removed: "2", inserted: "two" };

function run(actions: CsvEditSessionAction[]) {
  return actions.reduce(csvEditSessionReducer, createCsvEditSessionState());
}

describe("CSV edit session", () => {
  it("starts with inferred headers and nothing to undo", () => {
    const state = createCsvEditSessionState();

    expect(state.headerMode).toBe("auto");
    expect(undoableCsvPatch(state, "a,b\n1,2")).toBeNull();
  });

  it("pins the resolved header mode on the first edit and keeps a manual choice", () => {
    const pinned = run([
      { type: "committed", before: "v0", text: "v1", patch: firstPatch, headerMode: "header" },
    ]);
    const manual = run([
      { type: "setHeaderMode", mode: "data" },
      { type: "committed", before: "v0", text: "v1", patch: firstPatch, headerMode: "header" },
    ]);

    expect(pinned.headerMode).toBe("header");
    expect(manual.headerMode).toBe("data");
  });

  it("offers the latest edit for undo while the buffer is the text it produced", () => {
    const state = run([
      { type: "committed", before: "v0", text: "v1", patch: firstPatch, headerMode: "header" },
      { type: "committed", before: "v1", text: "v2", patch: secondPatch, headerMode: "header" },
    ]);

    expect(undoableCsvPatch(state, "v2")).toBe(secondPatch);
    expect(undoableCsvPatch(state, "typed in Source")).toBeNull();
  });

  it("walks back one edit at a time", () => {
    const state = run([
      { type: "committed", before: "v0", text: "v1", patch: firstPatch, headerMode: "header" },
      { type: "committed", before: "v1", text: "v2", patch: secondPatch, headerMode: "header" },
      { type: "undone", text: "v1" },
    ]);

    expect(undoableCsvPatch(state, "v1")).toBe(firstPatch);
    expect(
      undoableCsvPatch(csvEditSessionReducer(state, { type: "undone", text: "v0" }), "v0"),
    ).toBeNull();
  });

  it("drops earlier edits when the buffer changed outside the grid before a new edit", () => {
    const state = run([
      { type: "committed", before: "v0", text: "v1", patch: firstPatch, headerMode: "header" },
      {
        type: "committed",
        before: "agent wrote",
        text: "v2",
        patch: secondPatch,
        headerMode: "header",
      },
      { type: "undone", text: "agent wrote" },
    ]);

    expect(undoableCsvPatch(state, "agent wrote")).toBeNull();
  });
});
