import { describe, expect, test } from "vitest";

import { deriveClaudeToolDetail } from "./tool-call-detail-parser.js";

const URL = "https://claude.ai/code/artifact/8f2c1d90-0000-4000-8000-000000000000";

function derive(input: unknown, output: unknown) {
  return deriveClaudeToolDetail("Artifact", input, output);
}

describe("Artifact tool detail", () => {
  test("surfaces the published URL and title", () => {
    expect(
      derive({ file_path: "report.html", title: "Q3 revenue" }, `Published to ${URL}`),
    ).toEqual({
      type: "artifact",
      url: URL,
      title: "Q3 revenue",
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

  test("omits an empty title rather than carrying a blank one", () => {
    const detail = derive({ file_path: "a.html", title: "   " }, URL);
    expect(detail).toEqual({ type: "artifact", url: URL });
  });
});
