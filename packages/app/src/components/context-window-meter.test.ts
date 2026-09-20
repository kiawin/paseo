import { describe, expect, test } from "vitest";
import { buildPromptCacheLabel } from "./context-window-meter";

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
