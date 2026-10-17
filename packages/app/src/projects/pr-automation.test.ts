import { describe, expect, it } from "vitest";
import { formatReviewProvider, parseReviewProvider } from "./pr-automation";

describe("parseReviewProvider", () => {
  it("reads a bare provider", () => {
    expect(parseReviewProvider("codex")).toEqual({ provider: "codex", model: "" });
  });

  it("splits provider and model on the first slash", () => {
    expect(parseReviewProvider("opencode/openrouter/anthropic/claude")).toEqual({
      provider: "opencode",
      model: "openrouter/anthropic/claude",
    });
  });

  it("treats null and blank as no reviewer", () => {
    expect(parseReviewProvider(null)).toBeNull();
    expect(parseReviewProvider("  ")).toBeNull();
  });
});

describe("formatReviewProvider", () => {
  it("joins provider and model", () => {
    expect(formatReviewProvider({ provider: "claude", model: "opus" })).toBe("claude/opus");
  });

  it("stores the provider alone when no model is chosen", () => {
    expect(formatReviewProvider({ provider: "claude", model: "" })).toBe("claude");
  });

  it("round-trips a model that contains slashes", () => {
    const value = "opencode/openrouter/anthropic/claude";
    const parsed = parseReviewProvider(value);
    expect(parsed && formatReviewProvider(parsed)).toBe(value);
  });
});
