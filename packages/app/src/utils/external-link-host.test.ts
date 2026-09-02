import { describe, expect, test } from "vitest";

import { externalLinkHost } from "./external-link-host";

describe("externalLinkHost", () => {
  test("names the host of an https URL", () => {
    expect(externalLinkHost("https://claude.ai/code/artifact/abc")).toBe("claude.ai");
  });

  test("drops credentials, port, path and query from the label", () => {
    expect(externalLinkHost("https://user:pw@reports.example.com:8443/q3?x=1#top")).toBe(
      "reports.example.com",
    );
  });

  test("returns null for a string that is not a URL, so the caller shows it verbatim", () => {
    expect(externalLinkHost("not a url")).toBeNull();
    expect(externalLinkHost("")).toBeNull();
  });

  test("returns null for a scheme with no host rather than an empty label", () => {
    expect(externalLinkHost("mailto:someone@example.com")).toBeNull();
    expect(externalLinkHost("data:text/html,<h1>hi</h1>")).toBeNull();
  });

  test("keeps a punycode host as written — the label must not claim a name it does not have", () => {
    expect(externalLinkHost("https://xn--80ak6aa92e.com/path")).toBe("xn--80ak6aa92e.com");
  });
});
