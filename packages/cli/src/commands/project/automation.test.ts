import { describe, expect, it } from "vitest";
import { applyAutoReviewChange, applyOwnReviewChange, parseOnOff } from "./automation.js";

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
      reviewProfileId: null,
    });
    expect(
      applyAutoReviewChange(
        { ...OFF, autoReview: true, reviewProvider: "claude", postReviews: true },
        { enabled: false },
      ),
    ).toEqual({ ...OFF, autoReview: false, reviewProvider: "claude", postReviews: true });
  });

  it("picks the reviewer by profile or by provider, not both", () => {
    expect(applyAutoReviewChange(OFF, { enabled: true, profile: "Review" }).reviewProfileId).toBe(
      "Review",
    );
    expect(
      applyAutoReviewChange(
        { ...OFF, reviewProfileId: "prof_1" },
        { enabled: true, provider: "codex" },
      ),
    ).toMatchObject({ reviewProvider: "codex", reviewProfileId: null });
    expect(() =>
      applyAutoReviewChange(OFF, { enabled: true, provider: "codex", profile: "Review" }),
    ).toThrow();
  });

  it("sets when reviewers look again, and rejects anything but request or push", () => {
    expect(applyAutoReviewChange(OFF, { enabled: true, reReviewOn: "push" }).reReviewOn).toBe(
      "push",
    );
    expect(() => applyAutoReviewChange(OFF, { enabled: true, reReviewOn: "always" })).toThrow();
  });
});

describe("own-PR reviews", () => {
  it("turns own-PR reviews on with a reviewer and a round limit, keeping the rest", () => {
    expect(
      applyOwnReviewChange(
        { ...OFF, autoReview: true },
        { enabled: true, provider: "codex", rounds: "5" },
      ),
    ).toEqual({
      ...OFF,
      autoReview: true,
      autoReviewOwn: true,
      reviewProvider: "codex",
      reviewProfileId: null,
      maxOwnReviewRounds: 5,
    });
    expect(
      applyOwnReviewChange(
        { ...OFF, autoReviewOwn: true, maxOwnReviewRounds: 2 },
        { enabled: false },
      ),
    ).toEqual({ ...OFF, autoReviewOwn: false, maxOwnReviewRounds: 2 });
  });

  it("rejects a round limit outside 1 to 10", () => {
    for (const rounds of ["0", "11", "2.5", "two"]) {
      expect(() => applyOwnReviewChange(OFF, { enabled: true, rounds })).toThrow();
    }
  });
});

describe("project review", () => {
  it("takes a PR number with or without a leading #", async () => {
    const { parsePrNumber } = await import("./review.js");
    expect(parsePrNumber("12")).toBe(12);
    expect(parsePrNumber("#12")).toBe(12);
    expect(() => parsePrNumber("12a")).toThrow();
  });
});
