import type { AgentContextUsage } from "@getpaseo/protocol/messages";

interface ContextCategory {
  id?: string;
  name: string;
  tokens: number;
  kind: "used" | "free" | "buffer" | "deferred";
  colorIndex: number;
}

interface ContextWindowRow extends ContextCategory {
  percentage: number;
  barPercentage: number;
}

export function buildContextWindowBreakdown(usage: AgentContextUsage | null) {
  const max = usage?.rawMaxTokens;
  if (!max || !Number.isFinite(max) || max <= 0 || !usage.categories?.length) return null;

  const categories: ContextCategory[] = [];
  for (const category of usage.categories) {
    if (
      !category.name ||
      category.tokens === undefined ||
      !Number.isFinite(category.tokens) ||
      category.tokens < 0 ||
      !category.kind
    )
      continue;
    categories.push({
      id: category.id,
      name: category.name,
      tokens: category.tokens,
      kind: category.kind,
      colorIndex: categories.length,
    });
  }
  const occupied = categories.filter(
    (category) => category.kind === "used" || category.kind === "buffer",
  );
  const occupiedTokens = occupied.reduce((total, category) => total + category.tokens, 0);
  // Over-limit categories still show their real percentages, while the bar fits its track.
  const barDenominator = Math.max(max, occupiedTokens);
  const rows: ContextWindowRow[] = categories
    .filter((category) => category.kind !== "deferred")
    .map((category) => ({
      id: category.id,
      name: category.name,
      tokens: category.tokens,
      kind: category.kind,
      colorIndex: category.colorIndex,
      percentage: (category.tokens / max) * 100,
      barPercentage: category.kind === "free" ? 0 : (category.tokens / barDenominator) * 100,
    }));
  const deferred = categories.filter((category) => category.kind === "deferred");
  if (rows.length === 0 && deferred.length === 0) return null;
  return { rows, deferred };
}
