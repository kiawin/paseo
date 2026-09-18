export const CSV_BUDGET = {
  native: 2 * 1024 * 1024,
  web: 8 * 1024 * 1024,
} as const;

export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 256;
export const MAX_CELLS = 400_000;

const SNIFF_RECORD_LIMIT = 5;

export type CsvDelimiter = "," | ";" | "\t";
export type CsvHeaderMode = "auto" | "header" | "data";

export interface CsvTokenizationOptions {
  delimiter: CsvDelimiter;
  maxRows?: number;
  maxColumns?: number;
  maxCells?: number;
}

export interface CsvTokenizationResult {
  rows: string[][];
  truncated: boolean;
  unterminatedQuote: boolean;
}

export interface CsvHeaderResolution {
  hasHeader: boolean;
  headers: string[];
  bodyRows: string[][];
  raggedRowIndices: number[];
}

export interface ParsedCsv {
  delimiter: CsvDelimiter;
  rows: string[][];
  truncated: boolean;
  unterminatedQuote: boolean;
  header: CsvHeaderResolution;
}

interface QuotedCharacterResult {
  field: string;
  inQuotes: boolean;
  index: number;
}

export function csvByteBudget(isWebPlatform: boolean): number {
  return isWebPlatform ? CSV_BUDGET.web : CSV_BUDGET.native;
}

export function exceedsCsvByteBudget(size: number, isWebPlatform: boolean): boolean {
  return size > csvByteBudget(isWebPlatform);
}

export function parseCsv(
  content: string,
  input: { filePath?: string; headerMode?: CsvHeaderMode } = {},
): ParsedCsv {
  const delimiter = sniffDelimiter(content, input.filePath);
  const tokenized = tokenizeCsv(content, { delimiter });
  return {
    delimiter,
    ...tokenized,
    header: resolveCsvHeader(tokenized.rows, input.headerMode ?? "auto"),
  };
}

export function tokenizeCsv(
  content: string,
  options: CsvTokenizationOptions,
): CsvTokenizationResult {
  const maxRows = options.maxRows ?? MAX_ROWS;
  const maxColumns = options.maxColumns ?? MAX_COLUMNS;
  const maxCells = options.maxCells ?? MAX_CELLS;
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let recordStarted = false;
  let totalCells = 0;
  let truncated = false;
  let unterminatedQuote = false;

  const stop = () => {
    truncated = true;
  };

  const pushField = (): boolean => {
    if (row.length >= maxColumns || totalCells + row.length + 1 > maxCells) {
      stop();
      return false;
    }
    row.push(field);
    field = "";
    return true;
  };

  const pushRow = (): boolean => {
    if (rows.length >= maxRows) {
      stop();
      return false;
    }
    rows.push(row);
    totalCells += row.length;
    row = [];
    recordStarted = false;
    return true;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inQuotes) {
      const quoted = consumeQuotedCharacter({ source, index, field });
      field = quoted.field;
      inQuotes = quoted.inQuotes;
      index = quoted.index;
      continue;
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true;
      recordStarted = true;
      continue;
    }
    if (character === options.delimiter) {
      recordStarted = true;
      if (!pushField()) break;
      continue;
    }
    if (isRecordTerminator(character)) {
      if (!pushField() || !pushRow()) break;
      index = skipCrLf(source, index, character);
      continue;
    }

    field += character;
    recordStarted = true;
  }

  if (!truncated) {
    unterminatedQuote = inQuotes;
    if (recordStarted || row.length > 0 || field.length > 0) {
      if (pushField()) pushRow();
    }
  }

  return { rows, truncated, unterminatedQuote };
}

function isRecordTerminator(character: string | undefined): boolean {
  return character === "\n" || character === "\r";
}

function skipCrLf(source: string, index: number, character: string | undefined): number {
  return character === "\r" && source[index + 1] === "\n" ? index + 1 : index;
}

function consumeQuotedCharacter(input: {
  source: string;
  index: number;
  field: string;
}): QuotedCharacterResult {
  if (input.source[input.index] !== '"') {
    return { field: input.field + input.source[input.index], inQuotes: true, index: input.index };
  }
  if (input.source[input.index + 1] === '"') {
    return { field: input.field + '"', inQuotes: true, index: input.index + 1 };
  }
  return { field: input.field, inQuotes: false, index: input.index };
}

export function resolveCsvHeader(
  rows: readonly string[][],
  mode: CsvHeaderMode,
): CsvHeaderResolution {
  const hasHeader = mode === "header" || (mode === "auto" && shouldInferHeader(rows));
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const headerRow = hasHeader ? (rows[0] ?? []) : [];
  const headers = Array.from({ length: Math.max(width, headerRow.length) }, (_, index) => {
    const value = headerRow[index]?.trim() ?? "";
    return value.length > 0 ? value : `Column ${index + 1}`;
  });
  const bodyRows = hasHeader ? rows.slice(1) : [...rows];
  const raggedRowIndices = bodyRows.flatMap((row, index) =>
    row.length === headers.length ? [] : [index],
  );
  return { hasHeader, headers, bodyRows, raggedRowIndices };
}

export function shouldInferHeader(rows: readonly string[][]): boolean {
  const first = rows[0];
  const second = rows[1];
  if (!first) return false;
  if (!second) return true;
  if (first.length !== second.length) return true;
  if (first.some((value) => value.trim().length === 0)) return true;
  if (hasDuplicateNonEmptyValues(first)) return true;

  // Plain text is not evidence of a data row. This keeps ordinary all-text files
  // and labels such as "2023" as headers while still recognizing numeric/date
  // tables that have no header row.
  const parsesLikeData = first.every((value, index) => {
    const firstKind = inferCellKind(value);
    const secondKind = inferCellKind(second[index] ?? "");
    return firstKind !== "text" && firstKind !== "empty" && firstKind === secondKind;
  });
  return !parsesLikeData;
}

function hasDuplicateNonEmptyValues(row: readonly string[]): boolean {
  const values = row.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);
  return new Set(values).size !== values.length;
}

type CsvCellKind = "empty" | "text" | "number" | "year" | "date" | "boolean";

function inferCellKind(value: string): CsvCellKind {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "empty";
  if (/^(?:true|false)$/iu.test(trimmed)) return "boolean";
  if (/^\d{4}$/.test(trimmed)) return "year";
  if (/^\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(trimmed)) {
    return "date";
  }
  if (Number.isFinite(Number(trimmed))) return "number";
  return "text";
}

function sniffDelimiter(content: string, filePath?: string): CsvDelimiter {
  const normalizedPath = filePath?.trim().toLowerCase() ?? "";
  if (normalizedPath.endsWith(".tsv") || normalizedPath.endsWith(".tab")) return "\t";

  const candidates: CsvDelimiter[] = [",", ";", "\t"];
  const consistent = candidates.flatMap((delimiter, order) => {
    const sample = tokenizeCsv(content, {
      delimiter,
      maxRows: SNIFF_RECORD_LIMIT,
      maxColumns: MAX_COLUMNS,
      maxCells: MAX_CELLS,
    });
    const counts = sample.rows.map((row) => row.length);
    if (counts.length < 2 || counts[0] <= 1 || !counts.every((count) => count === counts[0])) {
      return [];
    }
    return [{ delimiter, fieldCount: counts[0], order }];
  });
  consistent.sort((left, right) => right.fieldCount - left.fieldCount || left.order - right.order);
  return consistent[0]?.delimiter ?? ",";
}
