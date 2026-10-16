import type { PullRequestCheck } from "../../services/forge-service.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";
import type { PrWatchRecord } from "./store.js";

export type PrWatchPullRequest = NonNullable<WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"]>;

export interface PrWatchCiFailure {
  key: string;
  check: PullRequestCheck;
}

export type PrWatchObservation =
  /** The branch has no PR right now, or a different one than the watch was set on. */
  | { kind: "not_watched_pull_request" }
  | { kind: "ended"; reason: "merged" | "closed" }
  | {
      kind: "open";
      headSha: string | null;
      /** The PR moved to a new commit since the watch last recorded one. */
      headChanged: boolean;
      /** Failed checks on the current head the agent hasn't been told about. */
      newFailures: PrWatchCiFailure[];
      /** No check on the current head is still running. */
      checksSettled: boolean;
    };

export function observePullRequest(
  record: PrWatchRecord,
  pullRequest: PrWatchPullRequest | null,
): PrWatchObservation {
  if (!pullRequest || (record.prNumber !== null && pullRequest.number !== record.prNumber)) {
    return { kind: "not_watched_pull_request" };
  }
  if (pullRequest.isMerged) {
    return { kind: "ended", reason: "merged" };
  }
  if (pullRequest.state === "closed") {
    return { kind: "ended", reason: "closed" };
  }

  const headSha = pullRequest.headSha ?? null;
  const headChanged =
    record.ci.headSha !== null && headSha !== null && headSha !== record.ci.headSha;
  const seen = new Set(headChanged ? [] : record.ci.seenFailureKeys);
  const checks = pullRequest.checks ?? [];
  const newFailures = checks
    .filter((check) => check.status === "failure")
    .map((check) => ({ key: ciFailureKey(check, headSha), check }))
    .filter((failure) => !seen.has(failure.key));

  return {
    kind: "open",
    headSha,
    headChanged,
    newFailures,
    checksSettled: !checks.some((check) => check.status === "pending"),
  };
}

/**
 * Identifies one check failing on one head. GitHub's batch poll reports check-run
 * ids but `gh pr view` doesn't, so the key uses only what every fetch reports; a
 * re-run of the same check on the same head is the same failure.
 */
export function ciFailureKey(check: PullRequestCheck, headSha: string | null): string {
  return `${headSha ?? "unknown-head"}:${check.workflow ?? ""}:${check.name}`;
}
