import { describe, expect, it } from "vitest";
import {
  CSV_MAX_COLUMN_WIDTH,
  CSV_MEASUREMENT_ROW_LIMIT,
  CSV_MIN_COLUMN_WIDTH,
  clampHorizontalOffset,
  csvRowLayout,
  keepCsvColumnWidths,
  measureCsvColumnGeometry,
} from "./geometry";

describe("CSV geometry", () => {
  it("uses shaped graphemes instead of UTF-16 length for CJK, emoji, and combining marks", () => {
    const result = measureCsvColumnGeometry({
      headers: ["h"],
      rows: [["中"], ["👨‍👩‍👧‍👦"], ["é"]],
      measurer: {
        measure: (text) => Array.from(text).length * 10,
        measureWidth: (graphemes) =>
          graphemes.reduce((width, grapheme) => width + (grapheme === "中" ? 30 : 20), 0),
      },
    });

    expect(result.widths[0]).toBe(30 + 24 + 16 + 28);
    expect(result.widths[0]).not.toBeGreaterThan(CSV_MAX_COLUMN_WIDTH);
  });

  it("clamps narrow and wide columns", () => {
    const narrow = measureCsvColumnGeometry({
      headers: [""],
      rows: [[]],
      measurer: { measure: () => 0 },
    });
    const wide = measureCsvColumnGeometry({
      headers: ["x".repeat(10_000)],
      rows: [],
      measurer: { measure: (text) => text.length },
    });

    expect(narrow.widths[0]).toBe(CSV_MIN_COLUMN_WIDTH);
    expect(wide.widths[0]).toBe(CSV_MAX_COLUMN_WIDTH);
  });

  it("classifies columns across all retained rows, not only the measurement window", () => {
    const rows = Array.from({ length: CSV_MEASUREMENT_ROW_LIMIT + 1 }, (_, index) => [
      index === CSV_MEASUREMENT_ROW_LIMIT ? "not numeric" : String(index),
      index === CSV_MEASUREMENT_ROW_LIMIT ? "42" : "",
    ]);
    const result = measureCsvColumnGeometry({
      headers: ["id", "amount"],
      rows,
      measurer: { measure: () => 0 },
    });

    expect(result.columnKinds).toEqual(["text", "numeric"]);
  });

  it("keeps column widths across an edit while alignment follows the data", () => {
    const previous = {
      widths: [120, 200],
      totalWidth: 320,
      frozenWidth: 120,
      columnKinds: ["text", "numeric"] as const,
    };
    const measured = {
      widths: [120, 260],
      totalWidth: 380,
      frozenWidth: 120,
      columnKinds: ["text", "text"] as const,
    };

    expect(keepCsvColumnWidths(measured, previous)).toEqual({
      widths: [120, 200],
      totalWidth: 320,
      frozenWidth: 120,
      columnKinds: ["text", "text"],
    });
    expect(keepCsvColumnWidths({ ...measured, widths: [120, 260, 96] }, previous).widths).toEqual([
      120, 260, 96,
    ]);
  });

  it("calculates fixed row offsets and clamps horizontal pan", () => {
    expect(csvRowLayout(3, 40)).toEqual({ index: 3, length: 40, offset: 120 });
    expect(clampHorizontalOffset(-10, 900, 300)).toBe(0);
    expect(clampHorizontalOffset(500, 900, 300)).toBe(500);
    expect(clampHorizontalOffset(800, 900, 300)).toBe(600);
    expect(clampHorizontalOffset(30, 200, 300)).toBe(0);
  });
});
