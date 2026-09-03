import { pairDiffLines } from "@/utils/diff-pairing";
import type { DiffLine } from "@/utils/tool-call-parsers";

/**
 * Shapes the chat transcript's flat `DiffLine[]` into side-by-side rows.
 *
 * The chat parser keeps hunk headers as ordinary lines and carries no line numbers, so rows
 * are unnumbered and headers stay inline as their own row rather than becoming a gutter label.
 */
export type ChatSplitDiffRow =
  | { kind: "header"; line: DiffLine }
  | { kind: "pair"; left: DiffLine | null; right: DiffLine | null };

export function buildChatSplitDiffRows(diffLines: readonly DiffLine[]): ChatSplitDiffRow[] {
  const rows: ChatSplitDiffRow[] = [];
  let section: DiffLine[] = [];

  const flushSection = () => {
    if (!section.length) {
      return;
    }
    const pairs = pairDiffLines(
      section.map((line) => ({
        type: line.type,
        oldCell: line.type === "add" ? null : line,
        newCell: line.type === "remove" ? null : line,
      })),
    );
    for (const pair of pairs) {
      rows.push({ kind: "pair", left: pair.left, right: pair.right });
    }
    section = [];
  };

  for (const line of diffLines) {
    if (line.type === "header") {
      flushSection();
      rows.push({ kind: "header", line });
      continue;
    }
    section.push(line);
  }

  flushSection();
  return rows;
}
