import { describe, expect, it } from "vitest";
import { buildChatSplitDiffRows } from "./chat-split-diff";
import type { DiffLine } from "./tool-call-parsers";

const line = (type: DiffLine["type"], content: string): DiffLine => ({ type, content });

describe("buildChatSplitDiffRows", () => {
  it("puts a removal and its replacement on one row", () => {
    const rows = buildChatSplitDiffRows([line("remove", "-old"), line("add", "+new")]);

    expect(rows).toEqual([
      { kind: "pair", left: line("remove", "-old"), right: line("add", "+new") },
    ]);
  });

  it("leaves the absent side null when the sides are uneven", () => {
    const rows = buildChatSplitDiffRows([
      line("remove", "-a"),
      line("remove", "-b"),
      line("add", "+a"),
    ]);

    expect(rows).toEqual([
      { kind: "pair", left: line("remove", "-a"), right: line("add", "+a") },
      { kind: "pair", left: line("remove", "-b"), right: null },
    ]);
  });

  it("repeats a context line on both sides", () => {
    const rows = buildChatSplitDiffRows([line("context", " same")]);

    expect(rows).toEqual([
      { kind: "pair", left: line("context", " same"), right: line("context", " same") },
    ]);
  });

  it("keeps a hunk header as its own row and flushes the run before it", () => {
    const rows = buildChatSplitDiffRows([
      line("remove", "-a"),
      line("header", "@@ -1 +1 @@"),
      line("add", "+b"),
    ]);

    expect(rows).toEqual([
      { kind: "pair", left: line("remove", "-a"), right: null },
      { kind: "header", line: line("header", "@@ -1 +1 @@") },
      { kind: "pair", left: null, right: line("add", "+b") },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(buildChatSplitDiffRows([])).toEqual([]);
  });
});
