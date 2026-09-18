import { describe, expect, it } from "vitest";
import {
  CSV_BUDGET,
  MAX_CELLS,
  MAX_COLUMNS,
  MAX_ROWS,
  exceedsCsvByteBudget,
  parseCsv,
  resolveCsvHeader,
  tokenizeCsv,
} from "./parse";

describe("parseCsv", () => {
  it("handles escaped quotes, delimiters, embedded newlines, CRLF, and a BOM", () => {
    const result = parseCsv('\ufeffname,notes\r\nAda,"said ""hello, world""\nthen"\r\n');

    expect(result.rows).toEqual([
      ["name", "notes"],
      ["Ada", 'said "hello, world"\nthen'],
    ]);
    expect(result.delimiter).toBe(",");
    expect(result.header.hasHeader).toBe(true);
  });

  it("closes an unterminated quote at EOF", () => {
    const result = parseCsv('name,notes\nAda,"unfinished');

    expect(result.rows).toEqual([
      ["name", "notes"],
      ["Ada", "unfinished"],
    ]);
    expect(result.unterminatedQuote).toBe(true);
  });

  it("reports ragged body rows after header inference", () => {
    const result = parseCsv("name,age\nAda,37\nGrace");

    expect(result.header.raggedRowIndices).toEqual([1]);
  });

  it("uses tab for TSV and sniffs delimiters from parsed records", () => {
    expect(parseCsv("name\tage\nAda\t37", { filePath: "people.tsv" }).delimiter).toBe("\t");
    expect(parseCsv("name;age\nAda;37\nGrace;40").delimiter).toBe(";");
    expect(parseCsv('name,notes\nAda,"one\ntwo"\nGrace,three').delimiter).toBe(",");
  });

  it("does not treat a pipe as a delimiter candidate", () => {
    const result = parseCsv("name|notes,kind\nAda|hello,person");

    expect(result.delimiter).toBe(",");
    expect(result.rows).toEqual([
      ["name|notes", "kind"],
      ["Ada|hello", "person"],
    ]);
  });

  it("supports empty and header-only files", () => {
    expect(parseCsv("").rows).toEqual([]);
    expect(parseCsv("name,age\n").header.bodyRows).toEqual([]);
    expect(parseCsv("name,age\n").header.headers).toEqual(["name", "age"]);
  });
});

describe("tokenizeCsv caps", () => {
  it("stops at the row cap while tokenising", () => {
    const result = tokenizeCsv("a,b\n1,2\n3,4", { delimiter: ",", maxRows: 2 });

    expect(result.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(result.truncated).toBe(true);
  });

  it("stops before committing a row that exceeds the column cap", () => {
    const result = tokenizeCsv("a,b,c\n1,2,3", {
      delimiter: ",",
      maxColumns: 2,
    });

    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("stops before committing a row that exceeds the cell cap", () => {
    const result = tokenizeCsv("a,b\n1,2", {
      delimiter: ",",
      maxCells: 3,
    });

    expect(result.rows).toEqual([["a", "b"]]);
    expect(result.truncated).toBe(true);
  });

  it("uses the production caps by default", () => {
    expect(MAX_ROWS).toBe(10_000);
    expect(MAX_COLUMNS).toBe(256);
    expect(MAX_CELLS).toBe(400_000);
  });
});

describe("CSV header inference", () => {
  it.each([
    [
      ["name", "city"],
      ["Ada", "London"],
    ],
    [
      ["", "value"],
      ["1", "2"],
    ],
    [
      ["name", "name"],
      ["Ada", "Grace"],
    ],
    [
      ["2023", "2024"],
      ["Q1", "Q2"],
    ],
  ])("keeps %j as a header", (first, second) => {
    expect(resolveCsvHeader([first, second], "auto").hasHeader).toBe(true);
  });

  it("demotes a genuinely headerless numeric row", () => {
    const result = resolveCsvHeader(
      [
        ["1", "2"],
        ["3", "4"],
      ],
      "auto",
    );

    expect(result.hasHeader).toBe(false);
    expect(result.headers).toEqual(["Column 1", "Column 2"]);
    expect(result.bodyRows).toHaveLength(2);
  });

  it("demotes ambiguous year-looking rows in auto mode", () => {
    // 2023/2024 over 1500/1600 can be either a year header or numeric data.
    // Auto mode demotes it; the manual header toggle handles the user's intent.
    const result = resolveCsvHeader(
      [
        ["2023", "2024"],
        ["1500", "1600"],
      ],
      "auto",
    );

    expect(result.hasHeader).toBe(false);
  });

  it("lets the manual switch override auto inference in both directions", () => {
    const rows = [
      ["1", "2"],
      ["3", "4"],
    ];

    expect(resolveCsvHeader(rows, "header").hasHeader).toBe(true);
    expect(resolveCsvHeader(rows, "data").hasHeader).toBe(false);
  });
});

describe("CSV byte budget", () => {
  it("uses the native and web budgets and rejects only values above them", () => {
    expect(CSV_BUDGET.native).toBe(2 * 1024 * 1024);
    expect(CSV_BUDGET.web).toBe(8 * 1024 * 1024);
    expect(exceedsCsvByteBudget(CSV_BUDGET.native, false)).toBe(false);
    expect(exceedsCsvByteBudget(CSV_BUDGET.native + 1, false)).toBe(true);
    expect(exceedsCsvByteBudget(CSV_BUDGET.web, true)).toBe(false);
    expect(exceedsCsvByteBudget(CSV_BUDGET.web + 1, true)).toBe(true);
  });
});
