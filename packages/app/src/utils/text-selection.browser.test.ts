import { afterEach, describe, expect, it } from "vitest";
import { hasActiveTextSelection } from "./text-selection";

function mountText(text: string): Text {
  const host = document.createElement("div");
  host.textContent = text;
  document.body.append(host);
  const node = host.firstChild;
  if (!(node instanceof Text)) {
    throw new Error("Expected text node");
  }
  return node;
}

function select(node: Text, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("hasActiveTextSelection", () => {
  it("is false with nothing selected", () => {
    mountText("const answer = true;");
    expect(hasActiveTextSelection()).toBe(false);
  });

  it("is true while a range of text is highlighted", () => {
    const node = mountText("const answer = true;");
    select(node, 0, 5);
    expect(hasActiveTextSelection()).toBe(true);
  });

  // A caret is a collapsed range. Clicking into text leaves one behind, and that press is a
  // press, not the tail of a drag.
  it("is false for a caret", () => {
    const node = mountText("const answer = true;");
    select(node, 3, 3);
    expect(hasActiveTextSelection()).toBe(false);
  });
});
