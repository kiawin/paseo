import { describe, expect, it } from "vitest";
import {
  CSV_BUDGET,
  MAX_CELLS,
  MAX_COLUMNS,
  MAX_ROWS,
  exceedsCsvByteBudget,
  locateCsvField,
  parseCsv,
  resolveCsvHeader,
  tokenizeCsv,
  type CsvDelimiter,
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

  const threeRows = "a,b\n1,2\n3,4";
  const threeColumns = "a,b,c\n1,2,3";
  const fourCells = "a,b\n1,2";

  it.each([
    [
      "a row cap above the file",
      threeRows,
      { maxRows: 4 },
      {
        rows: [
          ["a", "b"],
          ["1", "2"],
          ["3", "4"],
        ],
        truncated: false,
        unterminatedQuote: false,
      },
    ],
    [
      "a row cap equal to the file",
      threeRows,
      { maxRows: 3 },
      {
        rows: [
          ["a", "b"],
          ["1", "2"],
          ["3", "4"],
        ],
        truncated: false,
        unterminatedQuote: false,
      },
    ],
    [
      "a row cap below the file",
      threeRows,
      { maxRows: 2 },
      {
        rows: [
          ["a", "b"],
          ["1", "2"],
        ],
        truncated: true,
        unterminatedQuote: false,
      },
    ],
    [
      "a column cap above the file",
      threeColumns,
      { maxColumns: 4 },
      {
        rows: [
          ["a", "b", "c"],
          ["1", "2", "3"],
        ],
        truncated: false,
        unterminatedQuote: false,
      },
    ],
    [
      "a column cap equal to the file",
      threeColumns,
      { maxColumns: 3 },
      {
        rows: [
          ["a", "b", "c"],
          ["1", "2", "3"],
        ],
        truncated: false,
        unterminatedQuote: false,
      },
    ],
    [
      "a column cap below the file",
      threeColumns,
      { maxColumns: 2 },
      { rows: [], truncated: true, unterminatedQuote: false },
    ],
    [
      "a cell cap above the file",
      fourCells,
      { maxCells: 5 },
      {
        rows: [
          ["a", "b"],
          ["1", "2"],
        ],
        truncated: false,
        unterminatedQuote: false,
      },
    ],
    [
      "a cell cap equal to the file",
      fourCells,
      { maxCells: 4 },
      {
        rows: [
          ["a", "b"],
          ["1", "2"],
        ],
        truncated: false,
        unterminatedQuote: false,
      },
    ],
    [
      "a cell cap below the file",
      fourCells,
      { maxCells: 3 },
      { rows: [["a", "b"]], truncated: true, unterminatedQuote: false },
    ],
    [
      "a row cap reached by an unterminated last record",
      'a\n"open',
      { maxRows: 1 },
      { rows: [["a"]], truncated: true, unterminatedQuote: true },
    ],
    [
      "a row cap reached before an unterminated record",
      'a\nb\n"open',
      { maxRows: 1 },
      { rows: [["a"]], truncated: true, unterminatedQuote: false },
    ],
    [
      "an unterminated last record within the row cap",
      'a\n"open',
      { maxRows: 2 },
      { rows: [["a"], ["open"]], truncated: false, unterminatedQuote: true },
    ],
  ])("reads %s", (_name, content, caps, expected) => {
    expect(tokenizeCsv(content, { delimiter: ",", ...caps })).toEqual(expected);
  });

  it("uses the production caps by default", () => {
    expect(MAX_ROWS).toBe(10_000);
    expect(MAX_COLUMNS).toBe(256);
    expect(MAX_CELLS).toBe(400_000);
  });
});

describe("locateCsvField", () => {
  function raw(content: string, record: number, column: number, delimiter: CsvDelimiter = ",") {
    const span = locateCsvField(content, delimiter, record, column);
    return span ? content.slice(span.start, span.end) : null;
  }

  it("returns the raw text of plain, quoted, and empty fields", () => {
    const content = 'name,notes,tail\nAda,"said ""hi"", twice",\n';

    expect(raw(content, 0, 1)).toBe("notes");
    expect(raw(content, 1, 1)).toBe('"said ""hi"", twice"');
    expect(raw(content, 1, 2)).toBe("");
    expect(locateCsvField(content, ",", 1, 1)).toMatchObject({
      quoted: true,
      value: 'said "hi", twice',
    });
    expect(locateCsvField(content, ",", 1, 0)).toMatchObject({ quoted: false, value: "Ada" });
  });

  it("finds fields across CRLF, lone CR, and quoted line breaks", () => {
    const content = 'a,b\r\n"one\r\ntwo",c\rd,e';

    expect(raw(content, 1, 0)).toBe('"one\r\ntwo"');
    expect(raw(content, 1, 1)).toBe("c");
    expect(raw(content, 2, 1)).toBe("e");
  });

  it("offsets past a byte order mark", () => {
    const content = "﻿name,age\nAda,37";

    expect(locateCsvField(content, ",", 0, 0)).toMatchObject({ start: 1, end: 5, value: "name" });
    expect(raw(content, 1, 1)).toBe("37");
  });

  it("finds ragged rows and the last record without a terminator", () => {
    const content = "a,b,c\nx\ny,z";

    expect(raw(content, 1, 0)).toBe("x");
    expect(raw(content, 2, 1)).toBe("z");
  });

  it("returns null for a cell or record the file does not have", () => {
    const content = "a,b\nc\n";

    expect(locateCsvField(content, ",", 1, 1)).toBeNull();
    expect(locateCsvField(content, ",", 2, 0)).toBeNull();
    expect(locateCsvField("", ",", 0, 0)).toBeNull();
  });

  it.each([
    ['"a"b,x', { start: 0, end: 4, quoted: true, value: "ab" }],
    [' "a",x', { start: 0, end: 4, quoted: false, value: ' "a"' }],
    ['a"b,x', { start: 0, end: 3, quoted: false, value: 'a"b' }],
    ['"",x', { start: 0, end: 2, quoted: true, value: "" }],
    ['"a""b",x', { start: 0, end: 6, quoted: true, value: 'a"b' }],
  ])("reads the permissive quoting in %j", (content, first) => {
    expect(locateCsvField(content, ",", 0, 0)).toEqual(first);
    expect(tokenizeCsv(content, { delimiter: "," }).rows).toEqual([[first.value, "x"]]);
  });

  it("runs an unterminated quoted field to the end of the file", () => {
    expect(locateCsvField('x,"open', ",", 0, 1)).toEqual({
      start: 2,
      end: 7,
      quoted: true,
      value: "open",
    });
  });

  it("finds fields the tokenizer's caps leave out", () => {
    const content = "a,b\n1,2\n3,4";

    expect(tokenizeCsv(content, { delimiter: ",", maxRows: 2 }).rows).toHaveLength(2);
    expect(locateCsvField(content, ",", 0, 0)).toEqual({
      start: 0,
      end: 1,
      quoted: false,
      value: "a",
    });
    expect(locateCsvField(content, ",", 1, 1)).toEqual({
      start: 6,
      end: 7,
      quoted: false,
      value: "2",
    });
    expect(locateCsvField(content, ",", 2, 0)).toEqual({
      start: 8,
      end: 9,
      quoted: false,
      value: "3",
    });
    expect(locateCsvField(content, ",", 2, 1)).toEqual({
      start: 10,
      end: 11,
      quoted: false,
      value: "4",
    });
    expect(locateCsvField("a,b\n1,2", ",", 1, 1)).toEqual({
      start: 6,
      end: 7,
      quoted: false,
      value: "2",
    });
    expect(locateCsvField("a,b,c\n1,2,3", ",", 1, 2)).toEqual({
      start: 10,
      end: 11,
      quoted: false,
      value: "3",
    });
  });

  it("uses the given delimiter", () => {
    expect(raw("a\tb,c\td", 0, 1, "\t")).toBe("b,c");
    expect(raw("a;b", 0, 1, ";")).toBe("b");
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
