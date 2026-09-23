/** Lowercased whitespace-separated terms; every one has to match for a row to count. */
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Up to 140 characters of `text` around `matchIndex`, with ellipses where it was cut. */
export function searchSnippet(text: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 45);
  const end = Math.min(text.length, matchIndex + 95);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
