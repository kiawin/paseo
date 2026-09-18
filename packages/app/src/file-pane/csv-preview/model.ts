import type { MatchRange } from "@getpaseo/protocol/search/text-match";
import { resolveCsvHeader, type CsvHeaderMode, type ParsedCsv } from "./parse";

export const MAX_DISTINCT = 200;

export type CsvSortDirection = "ascending" | "descending";

export interface CsvSortState {
  column: number;
  direction: CsvSortDirection;
}

export type CsvFilters = ReadonlyMap<number, ReadonlySet<string>>;

export interface CsvViewRow {
  values: readonly string[];
  originalIndex: number;
  matches: readonly MatchRange[][];
}

export interface CsvViewModel {
  headers: string[];
  rows: CsvViewRow[];
  headerMatches: MatchRange[][];
  headerMode: CsvHeaderMode;
  raggedRowIndices: number[];
}

export interface CsvDistinctValues {
  values: string[];
  capped: boolean;
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function isNumericColumn(values: Iterable<string | undefined>): boolean {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length > 0 && !Number.isFinite(Number(trimmed))) return false;
  }
  return true;
}

export function buildCsvViewModel(input: {
  parsed: ParsedCsv;
  headerMode: CsvHeaderMode;
  filters?: CsvFilters;
  columnQueries?: ReadonlyMap<number, string>;
  query?: string;
  sort?: CsvSortState | null;
}): CsvViewModel {
  const header = resolveCsvHeader(input.parsed.rows, input.headerMode);
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const headerMatches = header.headers.map((value) => findCsvMatchRanges(query, value));
  const rows = header.bodyRows
    .map((values, originalIndex) => ({
      values,
      originalIndex,
      matches: values.map((value) => findCsvMatchRanges(query, value)),
    }))
    .filter(({ values, matches }) => {
      if (!matchesFilters(values, input.filters, input.columnQueries)) return false;
      return (
        query.length === 0 ||
        matches.some((ranges) => ranges.length > 0) ||
        headerMatches.some((ranges) => ranges.length > 0)
      );
    });

  const sort = input.sort;
  if (sort) {
    const numeric = isNumericColumn(rows.map((row) => row.values[sort.column]));
    rows.sort((left, right) => compareCsvRows(left, right, sort, numeric));
  }

  return {
    headers: header.headers,
    rows,
    headerMatches,
    headerMode: input.headerMode,
    raggedRowIndices: header.raggedRowIndices,
  };
}

export function distinctValuesForColumn(
  rows: readonly (readonly string[])[],
  column: number,
): CsvDistinctValues {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[column] ?? "";
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length > MAX_DISTINCT) return { values: [], capped: true };
  }
  return { values, capped: false };
}

export function reconcileCsvFilters(
  filters: CsvFilters,
  columnCount: number,
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  for (const [column, values] of filters) {
    if (column < 0 || column >= columnCount) continue;
    result.set(column, new Set(values));
  }
  return result;
}

export function cycleCsvSort(current: CsvSortState | null, column: number): CsvSortState | null {
  if (!current || current.column !== column) return { column, direction: "ascending" };
  if (current.direction === "ascending") return { column, direction: "descending" };
  return null;
}

export function findCsvMatchRanges(query: string, text: string): MatchRange[] {
  if (query.length === 0) return [];
  const normalizedText = text.toLocaleLowerCase();
  const ranges: MatchRange[] = [];
  let start = 0;
  while (start < normalizedText.length) {
    const index = normalizedText.indexOf(query, start);
    if (index < 0) break;
    ranges.push({ start: index, length: query.length });
    start = index + query.length;
  }
  return ranges;
}

function matchesFilters(
  values: readonly string[],
  filters: CsvFilters | undefined,
  columnQueries: ReadonlyMap<number, string> | undefined,
): boolean {
  if (filters)
    for (const [column, selected] of filters) {
      if (selected.size > 0 && !selected.has(values[column] ?? "")) return false;
    }
  if (columnQueries)
    for (const [column, query] of columnQueries) {
      if (
        query.length > 0 &&
        !(values[column] ?? "").toLocaleLowerCase().includes(query.toLocaleLowerCase())
      ) {
        return false;
      }
    }
  return true;
}

function compareCsvRows(
  left: CsvViewRow,
  right: CsvViewRow,
  sort: CsvSortState,
  numeric: boolean,
): number {
  const column = sort.column;
  const leftValue = left.values[column] ?? "";
  const rightValue = right.values[column] ?? "";
  const leftEmpty = leftValue.trim().length === 0;
  const rightEmpty = rightValue.trim().length === 0;
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return left.originalIndex - right.originalIndex;
    return leftEmpty ? 1 : -1;
  }

  const comparison = numeric
    ? Number(leftValue) - Number(rightValue)
    : naturalCollator.compare(leftValue, rightValue);
  if (comparison !== 0) {
    return sort.direction === "ascending" ? comparison : -comparison;
  }
  return left.originalIndex - right.originalIndex;
}
