import type { PullRequestCheck, PullRequestTimelineItem } from "../../services/forge-service.js";
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
      /** The PR's activity timestamp moved since the timeline was last read. */
      activityChanged: boolean;
      /** The head conflicts with the base branch and the agent hasn't been told for this head. */
      newConflict: boolean;
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
    activityChanged:
      pullRequest.updatedAt !== undefined && pullRequest.updatedAt !== record.review.lastUpdatedAt,
    newConflict:
      pullRequest.mergeable === "CONFLICTING" &&
      headSha !== null &&
      headSha !== record.conflict.notifiedHeadSha,
  };
}

/** Agents add this to every PR comment they post, so their own replies don't wake them. */
export const PR_WATCH_COMMENT_MARKER = "<!-- paseo-autofix -->";

/** Authors with write access to the repo; anyone else can post text that reaches the agent. */
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Bots whose reviews the agent answers. Kept short: a bot can relay text from
 * anyone who can trigger it.
 */
export const PR_WATCH_ALLOWED_BOT_LOGINS = new Set(["copilot-pull-request-reviewer"]);

/**
 * Review comments and reviews the agent should answer: written after the watch
 * started, by someone with repo access or an allowed bot, not by the agent
 * itself, and not in a resolved or outdated thread.
 */
export function selectNewReviewComments(
  record: PrWatchRecord,
  items: readonly PullRequestTimelineItem[],
): PullRequestTimelineItem[] {
  const since = Date.parse(record.review.since);
  const seen = new Set(record.review.seenCommentIds);
  return items.filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    if (!(item.createdAt > since)) return false;
    if (!item.body.trim() || item.body.includes(PR_WATCH_COMMENT_MARKER)) return false;
    if (!isTrustedAuthor(item)) return false;
    if (item.kind === "review") return item.reviewState !== "approved";
    return !item.threadIsResolved && !item.location?.isResolved && !item.location?.isOutdated;
  });
}

function isTrustedAuthor(item: PullRequestTimelineItem): boolean {
  if (item.authorIsBot) return PR_WATCH_ALLOWED_BOT_LOGINS.has(item.author);
  return (
    item.authorAssociation !== undefined && TRUSTED_AUTHOR_ASSOCIATIONS.has(item.authorAssociation)
  );
}

/**
 * Identifies one check failing on one head. GitHub's batch poll reports check-run
 * ids but `gh pr view` doesn't, so the key uses only what every fetch reports; a
 * re-run of the same check on the same head is the same failure.
 */
export function ciFailureKey(check: PullRequestCheck, headSha: string | null): string {
  return `${headSha ?? "unknown-head"}:${check.workflow ?? ""}:${check.name}`;
}
