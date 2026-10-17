import type { AgentProfile, ProjectPrAutomation } from "@getpaseo/protocol/messages";

export type NormalizedPrAutomation =
  | { ok: true; settings: ProjectPrAutomation }
  | { ok: false; error: string };

/**
 * Checks a project's PR automation before it is stored. A reviewer profile may
 * be named by id or by name; it is stored by id so renaming it keeps working.
 */
export function normalizePrAutomation(
  input: ProjectPrAutomation,
  profiles: readonly AgentProfile[],
): NormalizedPrAutomation {
  const reviewProvider = input.reviewProvider?.trim() || null;
  const profileRef = input.reviewProfileId?.trim() || null;
  const profile = profileRef
    ? (profiles.find((entry) => entry.id === profileRef) ??
      profiles.find((entry) => entry.name === profileRef))
    : null;
  if (profileRef && !profile) {
    return { ok: false, error: `No agent profile named ${profileRef}` };
  }
  if (input.autoReview && !reviewProvider && !profile) {
    return { ok: false, error: "Choose a reviewer provider to review automatically" };
  }
  const { reReviewOn } = input;
  if (reReviewOn !== undefined && reReviewOn !== "request" && reReviewOn !== "push") {
    return { ok: false, error: `Unknown re-review option: ${reReviewOn}` };
  }
  return {
    ok: true,
    settings: { ...input, reviewProvider, reviewProfileId: profile?.id ?? null },
  };
}
