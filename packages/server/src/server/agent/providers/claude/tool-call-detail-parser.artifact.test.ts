import { describe, expect, test } from "vitest";

import { deriveClaudeToolDetail } from "./tool-call-detail-parser.js";

const URL = "https://claude.ai/code/artifact/8f2c1d90-0000-4000-8000-000000000000";

function derive(input: unknown, output: unknown) {
  return deriveClaudeToolDetail("Artifact", input, output);
}

describe("Artifact tool detail", () => {
  test("surfaces the published URL, title and file", () => {
    expect(
      derive({ file_path: "report.html", title: "Q3 revenue" }, `Published to ${URL}`),
    ).toEqual({
      type: "artifact",
      url: URL,
      title: "Q3 revenue",
      filePath: "report.html",
    });
  });

  test("carries the file path so capture can read the document it published", () => {
    expect(derive({ file_path: "  /work/scratch/report.html  " }, URL)).toMatchObject({
      filePath: "/work/scratch/report.html",
    });
  });

  test("treats a missing action as publish", () => {
    expect(derive({ file_path: "a.html" }, URL)).toMatchObject({ type: "artifact", url: URL });
  });

  test("accepts an explicit publish action and a wrapped output", () => {
    expect(
      derive({ action: "publish", file_path: "a.html" }, { output: `ok ${URL}` }),
    ).toMatchObject({ type: "artifact", url: URL });
  });

  test.each(["list", "read", "comments", "resolve", "upload_asset"])(
    "leaves the %s action alone — only a publish produces a document",
    (action) => {
      expect(derive({ action }, `see ${URL}`)).toMatchObject({ type: "unknown" });
    },
  );

  test("falls through when the result carries no URL", () => {
    expect(derive({ file_path: "a.html" }, "No published artifacts yet.")).toMatchObject({
      type: "unknown",
    });
  });

  test("drops trailing sentence punctuation from the URL", () => {
    expect(derive({ file_path: "a.html" }, `Published to ${URL}.`)).toMatchObject({ url: URL });
  });

  test("ignores a non-http scheme", () => {
    expect(derive({ file_path: "a.html" }, "javascript:alert(1)")).toMatchObject({
      type: "unknown",
    });
  });

  test("falls back to the published file's name when the title is blank", () => {
    expect(derive({ file_path: "docs/Q3 Report.html", title: "   " }, URL)).toEqual({
      type: "artifact",
      url: URL,
      title: "Q3 Report",
      filePath: "docs/Q3 Report.html",
    });
  });

  test("a reported title wins over the file name", () => {
    expect(derive({ file_path: "report.html", title: "Q3 revenue" }, URL)).toMatchObject({
      title: "Q3 revenue",
    });
  });

  test("omits the title when neither the tool nor a file name offers one", () => {
    expect(derive({ action: "publish" }, URL)).toEqual({ type: "artifact", url: URL });
  });
});
