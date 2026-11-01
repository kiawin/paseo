import { describe, expect, it, test } from "vitest";
import { buildPromptCacheLabel, formatContextPercentage } from "./context-window-meter.utils";
import { buildContextWindowBreakdown } from "./context-window-breakdown.utils";

describe("context window breakdown", () => {
  it("groups categories by kind and excludes free and deferred tokens from the bar", () => {
    const breakdown = buildContextWindowBreakdown({
      rawMaxTokens: 100,
      categories: [
        { name: "Free-looking used category", tokens: 40, kind: "used" },
        { name: "Reserve", tokens: 10, kind: "buffer" },
        { name: "Available", tokens: 50, kind: "free" },
        { name: "Delayed", tokens: 200, kind: "deferred" },
      ],
    });
    expect(
      breakdown?.rows.map(({ percentage, barPercentage }) => [percentage, barPercentage]),
    ).toEqual([
      [40, 40],
      [10, 10],
      [50, 0],
    ]);
    expect(breakdown?.deferred.map(({ name }) => name)).toEqual(["Delayed"]);
  });

  it("fits an over-limit bar without hiding the actual percentages", () => {
    const breakdown = buildContextWindowBreakdown({
      rawMaxTokens: 100,
      categories: [
        { name: "One", tokens: 100, kind: "used" },
        { name: "Two", tokens: 50, kind: "buffer" },
      ],
    });
    expect(breakdown?.rows[0]?.percentage).toBe(100);
    expect(breakdown?.rows.reduce((sum, row) => sum + row.barPercentage, 0)).toBeCloseTo(100);
  });

  it("ignores incomplete categories and does not display an empty breakdown", () => {
    expect(buildContextWindowBreakdown({ rawMaxTokens: 0, categories: [] })).toBeNull();
    expect(
      buildContextWindowBreakdown({ rawMaxTokens: 100, categories: [{ name: "Incomplete" }] }),
    ).toBeNull();
  });
});

describe("context window meter formatting", () => {
  it("localizes percentages without hiding context overflow", () => {
    expect(formatContextPercentage(125, "en")).toBe("125%");
    expect(formatContextPercentage(42, "fr")).toBe("42\u00a0%");
  });
});

const NOW = 1_700_000_000_000;

function t(key: string, options?: { minutes?: number }): string {
  return options?.minutes === undefined ? key : `${key}:${options.minutes}`;
}

describe("buildPromptCacheLabel", () => {
  test("floors the countdown so the label never promises time the cache does not have", () => {
    const expiresAt = NOW + 48 * 60_000 + 59_000;

    expect(buildPromptCacheLabel(expiresAt, NOW, t as never)).toBe(
      "contextWindow.promptCacheWarmMinutes:48",
    );
  });

  test("reads as under a minute rather than rounding down to zero", () => {
    expect(buildPromptCacheLabel(NOW + 30_000, NOW, t as never)).toBe(
      "contextWindow.promptCacheWarmUnderMinute",
    );
  });

  test("says nothing once the cache has gone cold", () => {
    expect(buildPromptCacheLabel(NOW, NOW, t as never)).toBeNull();
    expect(buildPromptCacheLabel(NOW - 1, NOW, t as never)).toBeNull();
  });

  test("says nothing for a provider that cannot report an expiry", () => {
    expect(buildPromptCacheLabel(null, NOW, t as never)).toBeNull();
  });

  test("ignores a non-finite expiry rather than rendering NaN", () => {
    expect(buildPromptCacheLabel(Number.NaN, NOW, t as never)).toBeNull();
    expect(buildPromptCacheLabel(Number.POSITIVE_INFINITY, NOW, t as never)).toBeNull();
  });

  test("keeps the full hour bucket legible at its ceiling", () => {
    expect(buildPromptCacheLabel(NOW + 60 * 60_000, NOW, t as never)).toBe(
      "contextWindow.promptCacheWarmMinutes:60",
    );
  });
});
