import type { DiffLine } from "@/utils/tool-call-parsers";

/**
 * Picks the window a clamped diff should show.
 *
 * A preview has room for two or three lines, and the reader wants those lines to be what changed.
 * A hunk header and the context above the first edit are enough to fill that window on their own,
 * leaving a card that says an edit happened without showing any of it — so the window opens at the
 * first add or remove instead of at the top. A diff with no changes at all keeps its own first
 * lines, which is all it has.
 */
export function selectDiffPreviewLines(lines: readonly DiffLine[], limit: number): DiffLine[] {
  const firstChange = lines.findIndex((line) => line.type === "add" || line.type === "remove");
  const start = firstChange === -1 ? 0 : firstChange;
  return lines.slice(start, start + limit);
}

/** Whether the preview window leaves anything out, counting what it skipped past as well. */
export function diffPreviewIsClamped(lines: readonly DiffLine[], limit: number): boolean {
  return selectDiffPreviewLines(lines, limit).length < lines.length;
}
