import { describe, expect, it } from "vitest";
import { withPreviewCsp } from "@/file-pane/html-preview-csp";

describe("withPreviewCsp", () => {
  it("places the policy before the complete source document", () => {
    const source =
      " <!-- untrusted --!><!doctype html \"'><script>location='https://example.com'</script>";
    const output = withPreviewCsp(source, "about:srcdoc");

    expect(output).toMatch(
      /^<!doctype html><base href="about:srcdoc"><meta http-equiv="Content-Security-Policy"/,
    );
    expect(output.endsWith(source)).toBe(true);
    expect(output.indexOf("Content-Security-Policy")).toBeLessThan(output.indexOf("<script>"));
  });

  it("gives the document a base of its own, ahead of the policy that blocks any other", () => {
    const output = withPreviewCsp("<h1>Plan</h1>", "about:blank");

    expect(output.indexOf('<base href="about:blank">')).toBeLessThan(
      output.indexOf("Content-Security-Policy"),
    );
    expect(output).toContain("base-uri 'none'");
  });

  it("keeps the original document intact", () => {
    const source = "<!doctype html><html><head></head><body><h1>Visual plan</h1></body></html>";

    expect(withPreviewCsp(source, "about:srcdoc")).toContain(source);
  });

  it("drops a leading BOM before appending the source", () => {
    const output = withPreviewCsp("﻿<!doctype html><h1>Plan</h1>", "about:srcdoc");

    expect(output.includes("﻿")).toBe(false);
    expect(output).toContain("<!doctype html><h1>Plan</h1>");
  });

  it("refuses remote resources while allowing inline scripts and styles", () => {
    const document = withPreviewCsp("<h1>Plan</h1>", "about:srcdoc");

    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("base-uri 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain("object-src 'none'");
    expect(document).toContain("script-src 'unsafe-inline'");
    expect(document).toContain("style-src 'unsafe-inline'");
    expect(document).not.toMatch(/script-src[^;]*https:/);
    expect(document).not.toMatch(/img-src[^;]*https:/);
    expect(document).not.toMatch(/connect-src[^;]*https:/);
  });

  it("handles pathological source without parsing it", () => {
    const source = `${"<!--".repeat(10_000)}${'"'.repeat(10_000)}<html></html>`;

    expect(withPreviewCsp(source, "about:srcdoc").endsWith(source)).toBe(true);
  });
});
