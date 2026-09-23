import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { noteDocumentMatches, serializeNoteDocument } from "./text";

describe("note editor document text", () => {
  it("preserves the model's line separator when reading CodeMirror changes", () => {
    const state = EditorState.create({ doc: "one\ntwo" });

    expect(serializeNoteDocument(state.doc, "\r\n")).toBe("one\r\ntwo");
  });

  it("compares normalized CodeMirror documents instead of raw line-ending strings", () => {
    const state = EditorState.create({ doc: "one\ntwo" });

    expect(noteDocumentMatches(state, "one\r\ntwo")).toBe(true);
    expect(noteDocumentMatches(state, "one\r\nthree")).toBe(false);
  });
});
