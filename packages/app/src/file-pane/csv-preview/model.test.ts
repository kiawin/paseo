import { describe, expect, it } from "vitest";
import { MAX_ROWS, parseCsv } from "./parse";
import {
  MAX_DISTINCT,
  buildCsvViewModel,
  cycleCsvSort,
  distinctValuesForColumn,
  findCsvMatchRanges,
  reconcileCsvFilters,
} from "./model";

describe("CSV view model", () => {
  it("matches cells case-insensitively and keeps every row for a header-only match", () => {
    const parsed = parseCsv("Name,City\nAda,London\nGrace,New York");
    const result = buildCsvViewModel({ parsed, headerMode: "auto", query: "city" });

    expect(result.rows).toHaveLength(2);
    expect(result.headerMatches[1]).toEqual([{ start: 0, length: 4 }]);
    expect(result.rows[0]?.matches).toEqual([[], []]);
  });

  it("combines filters with OR within a column and AND across columns", () => {
    const parsed = parseCsv("Name,City\nAda,London\nGrace,Paris\nLin,London");
    const filters = new Map([
      [1, new Set(["London", "Paris"])],
      [0, new Set(["Ada", "Lin"])],
    ]);
    const result = buildCsvViewModel({ parsed, headerMode: "header", filters });

    expect(result.rows.map((row) => row.values[0])).toEqual(["Ada", "Lin"]);
  });

  it("sorts numeric and natural values, leaves empties last, and breaks ties by original index", () => {
    const parsed = parseCsv("Name,Value\nBeta,10\nalpha,2\nGamma,\nALPHA,2");
    const ascending = buildCsvViewModel({
      parsed,
      headerMode: "header",
      sort: { column: 1, direction: "ascending" },
    });
    const descending = buildCsvViewModel({
      parsed,
      headerMode: "header",
      sort: { column: 1, direction: "descending" },
    });

    expect(ascending.rows.map((row) => row.values[0])).toEqual(["alpha", "ALPHA", "Beta", "Gamma"]);
    expect(descending.rows.map((row) => row.values[0])).toEqual([
      "Beta",
      "alpha",
      "ALPHA",
      "Gamma",
    ]);
  });

  it("sorts a full-size retained CSV numerically", () => {
    const bodyRows = Array.from({ length: MAX_ROWS - 1 }, (_, index) => {
      const value = MAX_ROWS - 2 - index;
      return `row-${index},${value}`;
    });
    const result = buildCsvViewModel({
      parsed: parseCsv(["Name,Value", ...bodyRows].join("\n")),
      headerMode: "header",
      sort: { column: 1, direction: "ascending" },
    });

    expect(result.rows).toHaveLength(MAX_ROWS - 1);
    expect(result.rows.map((row) => row.values[1])).toEqual(
      Array.from({ length: MAX_ROWS - 1 }, (_, index) => String(index)),
    );
  });

  it("returns lazy distinct values and caps checklist construction", () => {
    const rows = Array.from({ length: MAX_DISTINCT + 1 }, (_, index) => [`value-${index}`]);

    expect(distinctValuesForColumn(rows, 0)).toEqual({ values: [], capped: true });
    expect(distinctValuesForColumn([["a"], ["b"], ["a"]], 0)).toEqual({
      values: ["a", "b"],
      capped: false,
    });
  });

  it("drops filters whose columns disappear after a re-parse", () => {
    const filters = new Map([
      [0, new Set(["Ada"])],
      [2, new Set(["old"])],
    ]);

    expect([...reconcileCsvFilters(filters, 2).keys()]).toEqual([0]);
  });
});

describe("CSV sort and matching helpers", () => {
  it("cycles ascending, descending, and none", () => {
    expect(cycleCsvSort(null, 2)).toEqual({ column: 2, direction: "ascending" });
    expect(cycleCsvSort({ column: 2, direction: "ascending" }, 2)).toEqual({
      column: 2,
      direction: "descending",
    });
    expect(cycleCsvSort({ column: 2, direction: "descending" }, 2)).toBeNull();
    expect(cycleCsvSort({ column: 1, direction: "descending" }, 2)).toEqual({
      column: 2,
      direction: "ascending",
    });
  });

  it("finds all case-insensitive substring ranges", () => {
    expect(findCsvMatchRanges("ana", "Banana ananas")).toEqual([
      { start: 1, length: 3 },
      { start: 7, length: 3 },
    ]);
    expect(findCsvMatchRanges("", "anything")).toEqual([]);
  });
});
