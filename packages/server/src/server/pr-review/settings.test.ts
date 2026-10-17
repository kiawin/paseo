import { describe, expect, test } from "vitest";

import { normalizePrAutomation } from "./settings.js";

const BASE = {
  autoReview: false,
  reviewProvider: null,
  postReviews: false,
  autoFixAgentPullRequests: false,
};
const PROFILES = [{ id: "prof_review", name: "Review", provider: "codex", model: "gpt-5" }];

describe("normalizePrAutomation", () => {
  test("stores a reviewer profile by id, whether named by id or by name", () => {
    expect(normalizePrAutomation({ ...BASE, reviewProfileId: "Review" }, PROFILES)).toEqual({
      ok: true,
      settings: { ...BASE, reviewProfileId: "prof_review" },
    });
    expect(
      normalizePrAutomation(
        { ...BASE, autoReview: true, reviewProfileId: "prof_review" },
        PROFILES,
      ),
    ).toMatchObject({ ok: true });
  });

  test("rejects an unknown profile, a reviewer-less auto-review, and an unknown re-review option", () => {
    expect(normalizePrAutomation({ ...BASE, reviewProfileId: "nope" }, PROFILES)).toEqual({
      ok: false,
      error: "No agent profile named nope",
    });
    expect(normalizePrAutomation({ ...BASE, autoReview: true }, PROFILES)).toMatchObject({
      ok: false,
    });
    expect(normalizePrAutomation({ ...BASE, reReviewOn: "always" }, PROFILES)).toMatchObject({
      ok: false,
    });
  });
});
