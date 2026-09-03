import { describe, expect, it } from "vitest";
import type { DiffLine } from "@/utils/tool-call-parsers";
import { diffPreviewIsClamped, selectDiffPreviewLines } from "@/utils/diff-preview";

function line(type: DiffLine["type"], content: string): DiffLine {
  return { type, content } as DiffLine;
}

const DIFF: DiffLine[] = [
  line("header", "@@ -42,7 +42,9 @@"),
  line("context", "const ref = useRef(null);"),
  line("remove", "const NEAR_BOTTOM_PX = 80;"),
  line("add", "const NEAR_BOTTOM_PX = 160;"),
  line("add", "const isDraggingRef = useRef(false);"),
];

describe("selectDiffPreviewLines", () => {
  it("opens the window at the first change rather than the top of the hunk", () => {
    // Taking the first two lines would spend the whole preview on the header and a context
    // line, so the card would show that an edit happened without showing any of it.
    expect(selectDiffPreviewLines(DIFF, 2).map((l) => l.type)).toEqual(["remove", "add"]);
    expect(selectDiffPreviewLines(DIFF, 3).map((l) => l.type)).toEqual(["remove", "add", "add"]);
  });

  it("keeps the first lines when nothing changed", () => {
    const contextOnly = [line("header", "@@ -1,2 +1,2 @@"), line("context", "unchanged")];
    expect(selectDiffPreviewLines(contextOnly, 2)).toEqual(contextOnly);
  });

  it("never returns more than the limit, and handles an empty diff", () => {
    expect(selectDiffPreviewLines(DIFF, 1)).toHaveLength(1);
    expect(selectDiffPreviewLines([], 3)).toEqual([]);
  });

  it("does not run past the end when the first change is near it", () => {
    expect(selectDiffPreviewLines(DIFF, 10)).toHaveLength(3);
  });
});

describe("diffPreviewIsClamped", () => {
  it("counts the lines skipped above the first change, not just the ones cut off below", () => {
    // Two lines shown out of five: three are hidden, two of them above the window.
    expect(diffPreviewIsClamped(DIFF, 2)).toBe(true);
    // The window still starts at the change, so the header and context stay hidden.
    expect(diffPreviewIsClamped(DIFF, 3)).toBe(true);
  });

  it("is false when the preview shows the whole diff", () => {
    const changesOnly = [line("add", "one"), line("add", "two")];
    expect(diffPreviewIsClamped(changesOnly, 2)).toBe(false);
    expect(diffPreviewIsClamped([], 3)).toBe(false);
  });
});
