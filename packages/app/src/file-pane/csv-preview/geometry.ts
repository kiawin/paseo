import { advancesFor, graphemeBoundaries, type TextMeasurer } from "@/text-measurement";
import { isNumericColumn } from "./model";

export const CSV_ROW_HEIGHT = 34;
export const CSV_HEADER_HEIGHT = 36;
export const CSV_MIN_COLUMN_WIDTH = 96;
export const CSV_MAX_COLUMN_WIDTH = 480;
export const CSV_CELL_HORIZONTAL_PADDING = 24;
export const CSV_SORT_CARET_WIDTH = 16;
export const CSV_FILTER_BUTTON_WIDTH = 28;
export const CSV_MEASUREMENT_ROW_LIMIT = 200;

export type CsvColumnKind = "numeric" | "text";

export interface CsvColumnGeometry {
  widths: readonly number[];
  totalWidth: number;
  frozenWidth: number;
  columnKinds: readonly CsvColumnKind[];
}

export interface CsvRowLayout {
  index: number;
  length: number;
  offset: number;
}

export function measureCsvColumnGeometry(input: {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  measurer: TextMeasurer;
}): CsvColumnGeometry {
  const columnKinds = input.headers.map((_, columnIndex) =>
    isNumericColumn(input.rows.map((row) => row[columnIndex])) ? "numeric" : "text",
  );
  const widths = input.headers.map((header, columnIndex) => {
    let maximum = measuredTextWidth(header, input.measurer);
    for (const row of input.rows.slice(0, CSV_MEASUREMENT_ROW_LIMIT)) {
      maximum = Math.max(maximum, measuredTextWidth(row[columnIndex] ?? "", input.measurer));
    }
    const actionWidth = CSV_SORT_CARET_WIDTH + CSV_FILTER_BUTTON_WIDTH;
    return clamp(
      Math.ceil(maximum + CSV_CELL_HORIZONTAL_PADDING + actionWidth),
      CSV_MIN_COLUMN_WIDTH,
      CSV_MAX_COLUMN_WIDTH,
    );
  });
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  return {
    widths,
    totalWidth,
    frozenWidth: widths[0] ?? CSV_MIN_COLUMN_WIDTH,
    columnKinds,
  };
}

export function csvRowLayout(index: number, rowHeight = CSV_ROW_HEIGHT): CsvRowLayout {
  return {
    index,
    length: rowHeight,
    offset: rowHeight * index,
  };
}

export function clampHorizontalOffset(
  offset: number,
  contentWidth: number,
  viewportWidth: number,
): number {
  return clamp(offset, 0, Math.max(0, contentWidth - viewportWidth));
}

function measuredTextWidth(text: string, measurer: TextMeasurer): number {
  if (text.length === 0) return 0;
  const boundaries = graphemeBoundaries(text);
  const graphemes = boundaries
    .slice(0, -1)
    .map((start, index) => text.slice(start, boundaries[index + 1]));
  if (measurer.measureWidth) return measurer.measureWidth(graphemes);
  return advancesFor(measurer)(graphemes).at(-1) ?? 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
