import { describe, expect, it } from "vitest";
import {
  CSV_EDIT_MAX_BYTES,
  applyCsvCellEdit,
  encodeCsvField,
  normalizeLineBreaks,
  restoreLineBreaks,
  revertCsvTextPatch,
  type CsvCellEditResult,
} from "./edit";
import { locateCsvField, parseCsv } from "./parse";

interface EditCase {
  text: string;
  record: number;
  column: number;
  value: string;
  filePath?: string;
  maxBytes?: number;
}

function edit({ text, record, column, value, filePath = "data.csv", maxBytes }: EditCase) {
  return applyCsvCellEdit({
    text,
    parsed: parseCsv(text, { filePath }),
    filePath,
    record,
    column,
    value,
    maxBytes: maxBytes ?? CSV_EDIT_MAX_BYTES,
  });
}

function applied(result: CsvCellEditResult) {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${result.status}`);
  return result;
}

function rejection(result: CsvCellEditResult) {
  if (result.status !== "rejected") throw new Error(`Expected rejected, got ${result.status}`);
  return result.reason;
}

describe("encodeCsvField", () => {
  const bare = { wasQuoted: false, tabSeparatedFile: false };
  const quoted = { wasQuoted: true, tabSeparatedFile: false };
  const tsv = { wasQuoted: false, tabSeparatedFile: true };

  it("leaves plain values bare and keeps an originally quoted field quoted", () => {
    expect(encodeCsvField("plain value", bare)).toBe("plain value");
    expect(encodeCsvField("", bare)).toBe("");
    expect(encodeCsvField("plain", quoted)).toBe('"plain"');
  });

  it("quotes quotes, line breaks, and every candidate delimiter", () => {
    expect(encodeCsvField('say "hi"', bare)).toBe('"say ""hi"""');
    expect(encodeCsvField("a,b", bare)).toBe('"a,b"');
    expect(encodeCsvField("a;b", bare)).toBe('"a;b"');
    expect(encodeCsvField("a\tb", bare)).toBe('"a\tb"');
    expect(encodeCsvField("a\nb", bare)).toBe('"a\nb"');
    expect(encodeCsvField("a\rb", bare)).toBe('"a\rb"');
  });

  it("writes a TSV value bare unless the field was already quoted", () => {
    expect(encodeCsvField("x, y; z", tsv)).toBe("x, y; z");
    expect(encodeCsvField('say "hi"', tsv)).toBe('say "hi"');
    expect(encodeCsvField('say "hi"', { wasQuoted: true, tabSeparatedFile: true })).toBe(
      '"say ""hi"""',
    );
  });
});

describe("applyCsvCellEdit", () => {
  const fixtures: Array<[string, EditCase]> = [
    ["LF", { text: "name,age\nAda,37\nGrace,40\n", record: 1, column: 1, value: "38" }],
    ["CRLF", { text: "name,age\r\nAda,37\r\nGrace,40\r\n", record: 2, column: 0, value: "Lin" }],
    ["mixed endings", { text: "a,b\r\nc,d\ne,f\rg,h", record: 2, column: 1, value: "changed" }],
    ["a byte order mark", { text: "﻿name,age\nAda,37\n", record: 0, column: 0, value: "id" }],
    ["no trailing newline", { text: "name,age\nAda,37", record: 1, column: 1, value: "38" }],
    [
      "quoted neighbours",
      { text: 'a,"b, with comma","c"\n1,"2",3\n', record: 1, column: 0, value: "one" },
    ],
    [
      "a neighbour with an embedded line break",
      { text: 'k,v\nx,"one\r\ntwo"\ny,z\n', record: 2, column: 1, value: "new" },
    ],
    ["a ragged row", { text: "a,b,c\nx\ny,z,w\n", record: 1, column: 0, value: "longer" }],
    ["a semicolon file", { text: "a;b\n1;2\n3;4\n", record: 1, column: 1, value: "x,y" }],
    [
      "a TSV file",
      { text: "a\tb\n1\t2\n", record: 1, column: 0, value: "x, y", filePath: "data.tsv" },
    ],
    [
      "a TSV value with a quote inside it",
      { text: "a\tb\n1\t2\n", record: 1, column: 1, value: 'x "y" z', filePath: "data.tab" },
    ],
    [
      "an already quoted TSV field given a value that opens with a quote",
      { text: 'a\tb\n"1"\t2\n', record: 1, column: 0, value: '"x" y', filePath: "data.tsv" },
    ],
    ["a value that needs quoting", { text: "a,b\n1,2\n", record: 1, column: 1, value: 'x "y", z' }],
    ["a value with a line break", { text: "a,b\n1,2\n", record: 1, column: 0, value: "x\ny" }],
    ["an originally quoted field", { text: 'a,b\n"1",2\n', record: 1, column: 0, value: "one" }],
    ["permissive quotes", { text: 'a,b\n"x"y, "z"\n', record: 1, column: 0, value: "plain" }],
    ["an emptied field", { text: "a,b\n1,2\n", record: 1, column: 0, value: "" }],
  ];

  it.each(fixtures)("changes one cell and no other byte with %s", (_name, input) => {
    const before = parseCsv(input.text, { filePath: input.filePath ?? "data.csv" });
    const span = locateCsvField(input.text, before.delimiter, input.record, input.column);
    if (!span) throw new Error("Fixture names a missing cell");

    const result = applied(edit(input));

    expect(result.text.slice(0, span.start)).toBe(input.text.slice(0, span.start));
    expect(result.text.slice(span.start + result.patch.inserted.length)).toBe(
      input.text.slice(span.end),
    );
    const expectedRows = before.rows.map((row) => [...row]);
    expectedRows[input.record][input.column] = input.value;
    expect(result.parsed.rows).toEqual(expectedRows);
    expect(result.parsed.delimiter).toBe(before.delimiter);
    expect(revertCsvTextPatch(result.text, result.patch)).toBe(input.text);
  });

  it("keeps the rows beyond the parser's row cap", () => {
    const rows = Array.from({ length: 10_001 }, (_, index) => `${index},value`);
    const text = `${rows.join("\n")}\n`;

    const result = applied(edit({ text, record: 9_999, column: 1, value: "edited" }));

    expect(result.parsed.truncated).toBe(true);
    expect(result.text.endsWith("9999,edited\n10000,value\n")).toBe(true);
    expect(result.text.length).toBe(text.length + 1);
  });

  it("reports an unchanged value without producing a patch", () => {
    expect(edit({ text: 'a,b\n"1",2\n', record: 1, column: 0, value: "1" })).toEqual({
      status: "unchanged",
    });
  });

  it("does not let a new value change the sniffed delimiter", () => {
    const text = "a;b\nc;d";

    const first = applied(edit({ text, record: 0, column: 0, value: "x,y" }));
    const second = applied(edit({ text: first.text, record: 1, column: 0, value: "z,w" }));

    expect(second.parsed.delimiter).toBe(";");
    expect(second.parsed.rows).toEqual([
      ["x,y", "b"],
      ["z,w", "d"],
    ]);
  });

  it("keeps a final single-field record when its value is emptied", () => {
    const result = edit({ text: "a\nb", record: 1, column: 0, value: "" });

    if (result.status === "applied") expect(result.parsed.rows).toEqual([["a"], [""]]);
    else expect(rejection(result)).toBe("unsafe");
  });

  it("rejects tabs and line breaks in a tab-delimited file", () => {
    const text = "a\tb\n1\t2\n";

    for (const value of ["x\ty", "x\ny", "x\ry"]) {
      expect(rejection(edit({ text, record: 1, column: 0, value, filePath: "data.tsv" }))).toBe(
        "tsv-control-character",
      );
    }
  });

  it("rejects a value that opens with a quote in a tab-delimited file instead of quoting it", () => {
    for (const filePath of ["data.tsv", "data.tab"]) {
      for (const value of ['"hi"', '"', '"open']) {
        expect(
          rejection(edit({ text: "a\tb\n1\t2\n", record: 1, column: 0, value, filePath })),
        ).toBe("tsv-leading-quote");
      }
    }
  });

  it("writes a quote inside a TSV value literally, so strict TSV readers see the same text", () => {
    const result = applied(
      edit({ text: "a\tb\n1\t2\n", record: 1, column: 0, value: 'say "hi"', filePath: "data.tsv" }),
    );

    expect(result.text).toBe('a\tb\nsay "hi"\t2\n');
  });

  it("still quotes a value that opens with a quote in a sniffed tab-delimited CSV", () => {
    const result = applied(edit({ text: "a\tb\n1\t2\n", record: 1, column: 0, value: '"hi"' }));

    expect(result.parsed.delimiter).toBe("\t");
    expect(result.text).toBe('a\tb\n"""hi"""\t2\n');
  });

  it("rejects a cell the file does not have", () => {
    expect(rejection(edit({ text: "a,b\nc\n", record: 1, column: 1, value: "x" }))).toBe("unsafe");
  });

  it("applies an edit that lands exactly on the byte limit and rejects one byte more", () => {
    const text = "a,b\n1,2\n";

    expect(edit({ text, record: 1, column: 1, value: "22", maxBytes: 9 }).status).toBe("applied");
    expect(rejection(edit({ text, record: 1, column: 1, value: "222", maxBytes: 9 }))).toBe(
      "too-large",
    );
  });

  it("counts bytes, not characters", () => {
    const text = "a,b\n1,2\n";

    expect(edit({ text, record: 1, column: 1, value: "é", maxBytes: 9 }).status).toBe("applied");
    expect(rejection(edit({ text, record: 1, column: 1, value: "日", maxBytes: 9 }))).toBe(
      "too-large",
    );
  });

  it("reserves room for the byte order mark the file handle adds back", () => {
    expect(CSV_EDIT_MAX_BYTES).toBe(1024 * 1024 - 3);

    const header = "a,b\n";
    const bare = `${header}${"x".repeat(CSV_EDIT_MAX_BYTES - header.length - 4)},y\n`;
    const atLimit = applied(edit({ text: bare, record: 1, column: 1, value: "yy" }));

    expect(new TextEncoder().encode(`﻿${atLimit.text}`).length).toBe(1024 * 1024);
    expect(rejection(edit({ text: bare, record: 1, column: 1, value: "yyy" }))).toBe("too-large");
  });
});

describe("revertCsvTextPatch", () => {
  it("restores the original bytes after several edits, quoting included", () => {
    const original = 'name,notes\r\nAda,plain\r\nGrace,"kept quoted"\r\n';
    const first = applied(edit({ text: original, record: 1, column: 1, value: "a, b" }));
    const second = applied(edit({ text: first.text, record: 2, column: 1, value: "x" }));
    const third = applied(edit({ text: second.text, record: 1, column: 0, value: 'A "d" a' }));

    const afterThird = revertCsvTextPatch(third.text, third.patch);
    const afterSecond = revertCsvTextPatch(afterThird, second.patch);

    expect(afterThird).toBe(second.text);
    expect(afterSecond).toBe(first.text);
    expect(revertCsvTextPatch(afterSecond, first.patch)).toBe(original);
  });
});

describe("line breaks in an edited value", () => {
  it("compares values the way a text area reports them", () => {
    expect(normalizeLineBreaks("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("writes a CRLF value back with CRLF and leaves other values as typed", () => {
    expect(restoreLineBreaks("one\r\ntwo", "one\ntwo\nthree")).toBe("one\r\ntwo\r\nthree");
    expect(restoreLineBreaks("one\ntwo", "one\ntwo\nthree")).toBe("one\ntwo\nthree");
    expect(restoreLineBreaks("one\r\ntwo\nthree", "a\nb")).toBe("a\nb");
    expect(restoreLineBreaks("plain", "a\nb")).toBe("a\nb");
  });

  it("returns the original when only the text area's line feeds differ", () => {
    expect(restoreLineBreaks("one\r\ntwo\nthree\rfour", "one\ntwo\nthree\nfour")).toBe(
      "one\r\ntwo\nthree\rfour",
    );
  });
});
