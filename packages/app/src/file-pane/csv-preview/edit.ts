import { isTabSeparatedPath, locateCsvField, parseCsv, type ParsedCsv } from "./parse";

/**
 * The host refuses writes above 1 MiB. The file handle prepends a 3-byte byte order mark to the
 * text of a file that had one, after this module has measured it, so the mark's room is reserved.
 */
export const CSV_EDIT_MAX_BYTES = 1024 * 1024 - 3;

/** One splice of the file's text. Reverting it restores the previous bytes exactly. */
export interface CsvTextPatch {
  offset: number;
  removed: string;
  inserted: string;
}

export type CsvCellEditRejection =
  | "tsv-control-character"
  | "tsv-leading-quote"
  | "too-large"
  | "unsafe";

export interface CsvCellEditInput {
  text: string;
  /** The parse of `text`. */
  parsed: ParsedCsv;
  filePath: string;
  /** Index into `parsed.rows`, so a header row counts. */
  record: number;
  column: number;
  value: string;
  maxBytes: number;
}

export type CsvCellEditResult =
  | { status: "applied"; text: string; parsed: ParsedCsv; patch: CsvTextPatch }
  | { status: "unchanged" }
  | { status: "rejected"; reason: CsvCellEditRejection };

export interface CsvFieldEncoding {
  /** The field being replaced was quoted, so the replacement stays quoted. */
  wasQuoted: boolean;
  /** The extension fixes the delimiter to tab; see `isTabSeparatedPath`. */
  tabSeparatedFile: boolean;
}

/**
 * Replaces one cell by splicing its raw field. The grid is never written back from the parse: the
 * parser stops at its row and cell caps, so serializing its rows would drop the rest of the file,
 * and it would rewrite every other field's quoting and line ending.
 */
export function applyCsvCellEdit(input: CsvCellEditInput): CsvCellEditResult {
  const { text, parsed, filePath, record, column, value } = input;
  const span = locateCsvField(text, parsed.delimiter, record, column);
  if (!span) return { status: "rejected", reason: "unsafe" };
  if (value === span.value) return { status: "unchanged" };

  const tabSeparatedFile = isTabSeparatedPath(filePath);
  if (tabSeparatedFile && /[\t\r\n]/.test(value)) {
    return { status: "rejected", reason: "tsv-control-character" };
  }
  // This reader would take the leading quote as the start of a quoted field, and quoting the
  // value to protect it puts literal quotes in front of every reader of strict TSV.
  if (tabSeparatedFile && !span.quoted && value.startsWith('"')) {
    return { status: "rejected", reason: "tsv-leading-quote" };
  }

  const inserted = encodeCsvField(value, { wasQuoted: span.quoted, tabSeparatedFile });
  const next = text.slice(0, span.start) + inserted + text.slice(span.end);
  if (exceedsByteLimit(next, input.maxBytes)) return { status: "rejected", reason: "too-large" };

  const nextParsed = parseCsv(next, { filePath });
  const edited: EditedCell = { record, column, value };
  if (!changesOnlyThatCell(parsed, nextParsed, edited)) {
    return { status: "rejected", reason: "unsafe" };
  }

  const patch = { offset: span.start, removed: text.slice(span.start, span.end), inserted };
  return { status: "applied", text: next, parsed: nextParsed, patch };
}

export function revertCsvTextPatch(text: string, patch: CsvTextPatch): string {
  const end = patch.offset + patch.inserted.length;
  return text.slice(0, patch.offset) + patch.removed + text.slice(end);
}

/**
 * A sniffed file quotes every candidate delimiter, not only its own, so a new value cannot make
 * the sniffer settle on a different one. A tab-separated file is never sniffed, and tools that
 * read strict TSV take quotes literally, so a field there is quoted only if it already was.
 */
export function encodeCsvField(value: string, encoding: CsvFieldEncoding): string {
  const needsQuotes = !encoding.tabSeparatedFile && /[",;\t\r\n]/.test(value);
  if (!encoding.wasQuoted && !needsQuotes) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** A web text area reports every line break as a line feed. */
export function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/**
 * The text area's value in the line-break style of the cell it replaces. A value whose only
 * difference is the text area's line feeds is the original.
 */
export function restoreLineBreaks(original: string, edited: string): string {
  if (normalizeLineBreaks(edited) === normalizeLineBreaks(original)) return original;
  const breaksOtherThanCrLf = original.replace(/\r\n/g, "");
  const usesOnlyCrLf = original.includes("\r\n") && !/[\r\n]/.test(breaksOtherThanCrLf);
  return usesOnlyCrLf ? normalizeLineBreaks(edited).replace(/\n/g, "\r\n") : edited;
}

interface EditedCell {
  record: number;
  column: number;
  value: string;
}

/**
 * The encoder reasons about one field. This checks the whole file: a new value can flip the
 * sniffed delimiter, and emptying the only field of a final record without a terminator removes
 * the record.
 */
function changesOnlyThatCell(before: ParsedCsv, after: ParsedCsv, edited: EditedCell): boolean {
  const beforeRow = before.rows[edited.record];
  const afterRow = after.rows[edited.record];
  if (!beforeRow || !afterRow) return false;
  const keepsShape =
    after.delimiter === before.delimiter &&
    after.rows.length === before.rows.length &&
    afterRow.length === beforeRow.length;
  const keepsWarnings =
    after.truncated === before.truncated && after.unterminatedQuote === before.unterminatedQuote;
  return keepsShape && keepsWarnings && afterRow[edited.column] === edited.value;
}

function exceedsByteLimit(text: string, maxBytes: number): boolean {
  const mostBytes = text.length * 3;
  if (mostBytes <= maxBytes) return false;
  return new TextEncoder().encode(text).length > maxBytes;
}
