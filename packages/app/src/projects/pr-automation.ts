import type { ProjectPrAutomation } from "@getpaseo/protocol/messages";

/** What an absent or null `projectPrAutomation` means on the wire: every automation off. */
export const DEFAULT_PR_AUTOMATION: ProjectPrAutomation = {
  autoReview: false,
  reviewProvider: null,
  postReviews: false,
  autoFixAgentPullRequests: false,
};

export interface ReviewerSelection {
  provider: string;
  /** Empty when the reviewer runs on the provider's default model. */
  model: string;
}

/**
 * `reviewProvider` is `provider` or `provider/model`. Model ids can contain slashes
 * (`openrouter/anthropic/claude`), so only the first one separates the provider,
 * matching how the daemon splits it.
 */
export function parseReviewProvider(value: string | null): ReviewerSelection | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { provider: trimmed, model: "" };
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

export function formatReviewProvider(selection: ReviewerSelection): string {
  return selection.model.length > 0
    ? `${selection.provider}/${selection.model}`
    : selection.provider;
}
