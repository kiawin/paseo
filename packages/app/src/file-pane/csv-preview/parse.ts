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
  const rows: string[][] = [];
  let row: string[] = [];
  let totalCells = 0;
  let truncated = false;

  const scan = scanCsv(content, options.delimiter, {
    field({ value }) {
      if (row.length >= maxColumns || totalCells + row.length + 1 > maxCells) {
        truncated = true;
        return false;
      }
      row.push(value);
      return true;
    },
    record() {
      if (rows.length >= maxRows) {
        truncated = true;
        return false;
      }
      rows.push(row);
      totalCells += row.length;
      row = [];
      return true;
    },
  });

  return { rows, truncated, unterminatedQuote: scan.unterminatedQuote };
}

/**
 * Where one field sits in the file's text: `start` and `end` bound its raw form, quotes included,
 * as offsets into the string the caller passed (a leading byte order mark counts).
 */
export interface CsvFieldSpan {
  start: number;
  end: number;
  /** The raw form opens with a quote. */
  quoted: boolean;
  value: string;
}

/** The field at `record` and `column`, read exactly as `tokenizeCsv` reads it, or null. */
export function locateCsvField(
  content: string,
  delimiter: CsvDelimiter,
  record: number,
  column: number,
): CsvFieldSpan | null {
  let currentRecord = 0;
  let currentColumn = 0;
  let found: CsvFieldSpan | null = null;

  scanCsv(content, delimiter, {
    field(field) {
      if (currentRecord === record && currentColumn === column) {
        const quoted = field.end > field.start && content[field.start] === '"';
        found = { ...field, quoted };
        return false;
      }
      currentColumn += 1;
      return true;
    },
    record() {
      if (currentRecord === record) return false;
      currentRecord += 1;
      currentColumn = 0;
      return true;
    },
  });

  return found;
}

interface CsvScannedField {
  start: number;
  end: number;
  value: string;
}

/** Receives fields and record ends in file order. Returning false stops the scan. */
interface CsvScanSink {
  field(field: CsvScannedField): boolean;
  record(): boolean;
}

interface CsvScanEnd {
  /** The file ended inside a quoted field. False when the sink stopped the scan first. */
  unterminatedQuote: boolean;
}

/** The one reader of CSV text. The tokenizer and the field locator both consume it. */
function scanCsv(content: string, delimiter: CsvDelimiter, sink: CsvScanSink): CsvScanEnd {
  let fieldStart = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  let field = "";
  let inQuotes = false;
  let recordStarted = false;

  for (let index = fieldStart; index < content.length; index += 1) {
    const character = content[index];

    if (inQuotes) {
      const quoted = consumeQuotedCharacter({ source: content, index, field });
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
    if (character === delimiter) {
      recordStarted = true;
      if (!sink.field({ start: fieldStart, end: index, value: field })) {
        return { unterminatedQuote: false };
      }
      field = "";
      fieldStart = index + 1;
      continue;
    }
    if (isRecordTerminator(character)) {
      if (!sink.field({ start: fieldStart, end: index, value: field }) || !sink.record()) {
        return { unterminatedQuote: false };
      }
      field = "";
      recordStarted = false;
      index = skipCrLf(content, index, character);
      fieldStart = index + 1;
      continue;
    }

    field += character;
    recordStarted = true;
  }

  if (recordStarted || field.length > 0) {
    if (sink.field({ start: fieldStart, end: content.length, value: field })) sink.record();
  }
  return { unterminatedQuote: inQuotes };
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

/** A file whose extension fixes its delimiter to tab, so it is never sniffed. */
export function isTabSeparatedPath(filePath: string | undefined): boolean {
  const normalizedPath = filePath?.trim().toLowerCase() ?? "";
  return normalizedPath.endsWith(".tsv") || normalizedPath.endsWith(".tab");
}

function sniffDelimiter(content: string, filePath?: string): CsvDelimiter {
  if (isTabSeparatedPath(filePath)) return "\t";

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
