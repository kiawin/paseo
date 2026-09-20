import type { TFunction } from "i18next";

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

export function buildPromptCacheLabel(
  expiresAtMs: number | null,
  nowMs: number,
  t: TFunction,
): string | null {
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) {
    return null;
  }
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) {
    return null;
  }
  const minutesLeft = Math.floor(remainingMs / 60_000);
  if (minutesLeft < 1) {
    return t("contextWindow.promptCacheWarmUnderMinute");
  }
  return t("contextWindow.promptCacheWarmMinutes", { minutes: minutesLeft });
}
