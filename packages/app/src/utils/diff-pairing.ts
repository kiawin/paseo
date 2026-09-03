/**
 * Pairs a run of removed lines with the added lines that follow it so a side-by-side view can
 * put a removal and its replacement on one row.
 *
 * The git panes and the chat transcript both need this, but they carry different cells: the
 * panes pair numbered, reviewable cells, while chat pairs plain highlighted lines with no line
 * numbers at all (most providers send `oldString`/`newString` with no file offsets). Pairing
 * never reads a line number, so it is generic over the cell and stays honest for both.
 */

export interface DiffPairRow<TCell> {
  left: TCell | null;
  right: TCell | null;
}

export interface DiffPairingEntry<TCell> {
  type: "add" | "remove" | "context" | "header";
  /** Old-side cell, or null when the line adds content that has no old-side counterpart. */
  oldCell: TCell | null;
  /** New-side cell, or null when the line removes content that has no new-side counterpart. */
  newCell: TCell | null;
}

/**
 * Entries must be one hunk's lines in file order. Headers are ignored — the caller owns where
 * they land, because the panes render them as their own row and chat renders them as a divider.
 */
export function pairDiffLines<TCell>(
  entries: readonly DiffPairingEntry<TCell>[],
): DiffPairRow<TCell>[] {
  const rows: DiffPairRow<TCell>[] = [];
  let pendingRemovals: TCell[] = [];
  let pendingAdditions: TCell[] = [];

  const flushPendingRows = () => {
    const pairCount = Math.max(pendingRemovals.length, pendingAdditions.length);
    for (let index = 0; index < pairCount; index += 1) {
      rows.push({
        left: pendingRemovals[index] ?? null,
        right: pendingAdditions[index] ?? null,
      });
    }
    pendingRemovals = [];
    pendingAdditions = [];
  };

  for (const entry of entries) {
    if (entry.type === "header") {
      continue;
    }

    if (entry.type === "remove") {
      if (entry.oldCell) {
        pendingRemovals.push(entry.oldCell);
      }
      continue;
    }

    if (entry.type === "add") {
      if (entry.newCell) {
        pendingAdditions.push(entry.newCell);
      }
      continue;
    }

    flushPendingRows();
    rows.push({ left: entry.oldCell, right: entry.newCell });
  }

  flushPendingRows();
  return rows;
}
