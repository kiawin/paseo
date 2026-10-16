import { describe, expect, it } from "vitest";
import { applyAutoReviewChange, parseOnOff } from "./automation.js";

const OFF = {
  autoReview: false,
  reviewProvider: null,
  postReviews: false,
  autoFixAgentPullRequests: true,
};

describe("project automation", () => {
  it("accepts only on and off", () => {
    expect(parseOnOff("on", "usage")).toBe(true);
    expect(parseOnOff("off", "usage")).toBe(false);
    expect(() => parseOnOff("yes", "usage")).toThrow();
  });

  it("changes only what the command names and keeps the other settings", () => {
    expect(applyAutoReviewChange(OFF, { enabled: true, provider: "codex/gpt-5" })).toEqual({
      ...OFF,
      autoReview: true,
      reviewProvider: "codex/gpt-5",
    });
    expect(
      applyAutoReviewChange(
        { ...OFF, autoReview: true, reviewProvider: "claude", postReviews: true },
        { enabled: false },
      ),
    ).toEqual({ ...OFF, autoReview: false, reviewProvider: "claude", postReviews: true });
  });
});
