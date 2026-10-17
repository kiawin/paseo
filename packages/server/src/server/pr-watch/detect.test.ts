import { describe, expect, test } from "vitest";

import type { PullRequestCheck, PullRequestTimelineItem } from "../../services/forge-service.js";
import {
  ciFailureKey,
  observePullRequest,
  PR_WATCH_COMMENT_MARKER,
  selectNewReviewComments,
  type PrWatchPullRequest,
} from "./detect.js";
import { createInitialPrWatchCiState, type PrWatchRecord } from "./store.js";

function watchRecord(ci: Partial<PrWatchRecord["ci"]> = {}): PrWatchRecord {
  return {
    agentId: "agent-1",
    cwd: "/repo/worktree",
    forge: "github",
    headRef: "feature/retry",
    prNumber: 42,
    prUrl: "https://github.com/acme/widgets/pull/42",
    state: { kind: "active" },
    ci: { ...createInitialPrWatchCiState(), ...ci },
    review: { since: "2026-10-17T00:00:00.000Z", lastUpdatedAt: null, seenCommentIds: [] },
    conflict: { notifiedHeadSha: null },
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
}

function check(overrides: Partial<PullRequestCheck> = {}): PullRequestCheck {
  return { name: "test", status: "success", url: "https://ci/test", ...overrides };
}

function pullRequest(overrides: Partial<PrWatchPullRequest> = {}): PrWatchPullRequest {
  return {
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add retry",
    state: "open",
    baseRefName: "main",
    headRefName: "feature/retry",
    headSha: "head-1",
    isMerged: false,
    checks: [],
    ...overrides,
  };
}

describe("observePullRequest", () => {
  test("reports failed checks the agent has not been told about", () => {
    const failed = check({ name: "lint", status: "failure", checkRunId: 7 });
    const observation = observePullRequest(
      watchRecord({ headSha: "head-1" }),
      pullRequest({ checks: [check(), failed] }),
    );

    expect(observation).toEqual({
      kind: "open",
      headSha: "head-1",
      headChanged: false,
      newFailures: [{ key: "head-1::lint", check: failed }],
      checksSettled: true,
      activityChanged: false,
      newConflict: false,
    });
  });

  test("skips failures already sent for the same head", () => {
    const observation = observePullRequest(
      watchRecord({ headSha: "head-1", seenFailureKeys: ["head-1::test"] }),
      pullRequest({ checks: [check({ status: "failure", checkRunId: 7 })] }),
    );

    expect(observation).toMatchObject({ kind: "open", newFailures: [] });
  });

  test("treats every failure on a new head as new", () => {
    const observation = observePullRequest(
      watchRecord({ headSha: "head-1", seenFailureKeys: ["head-1::test"] }),
      pullRequest({ headSha: "head-2", checks: [check({ status: "failure" })] }),
    );

    expect(observation).toMatchObject({
      kind: "open",
      headChanged: true,
      newFailures: [{ key: "head-2::test" }],
    });
  });

  test("is not settled while a check is still running", () => {
    const observation = observePullRequest(
      watchRecord(),
      pullRequest({ checks: [check({ status: "failure" }), check({ status: "pending" })] }),
    );

    expect(observation).toMatchObject({ kind: "open", checksSettled: false });
  });

  test("ends the watch when the PR merges or closes", () => {
    expect(observePullRequest(watchRecord(), pullRequest({ isMerged: true }))).toEqual({
      kind: "ended",
      reason: "merged",
    });
    expect(observePullRequest(watchRecord(), pullRequest({ state: "closed" }))).toEqual({
      kind: "ended",
      reason: "closed",
    });
  });

  test("ignores a missing PR or a different PR on the branch", () => {
    expect(observePullRequest(watchRecord(), null)).toEqual({ kind: "not_watched_pull_request" });
    expect(observePullRequest(watchRecord(), pullRequest({ number: 43 }))).toEqual({
      kind: "not_watched_pull_request",
    });
  });
});

describe("ciFailureKey", () => {
  test("is the same whether or not the fetch reported a check-run id", () => {
    expect(ciFailureKey(check({ workflow: "CI", name: "build", checkRunId: 9 }), "head-1")).toBe(
      ciFailureKey(check({ workflow: "CI", name: "build" }), "head-1"),
    );
  });

  test("differs per head, so a new commit's failure is new", () => {
    expect(ciFailureKey(check({ name: "build" }), "head-1")).not.toBe(
      ciFailureKey(check({ name: "build" }), "head-2"),
    );
  });
});

describe("observePullRequest activity and conflicts", () => {
  test("flags new activity when updatedAt moves past the last read", () => {
    const record = watchRecord();
    const fresh = observePullRequest(record, pullRequest({ updatedAt: "2026-10-17T01:00:00Z" }));
    const read = observePullRequest(
      { ...record, review: { ...record.review, lastUpdatedAt: "2026-10-17T01:00:00Z" } },
      pullRequest({ updatedAt: "2026-10-17T01:00:00Z" }),
    );

    expect(fresh).toMatchObject({ kind: "open", activityChanged: true });
    expect(read).toMatchObject({ kind: "open", activityChanged: false });
  });

  test("reports a conflict once per head", () => {
    const record = watchRecord();
    const conflicting = pullRequest({ mergeable: "CONFLICTING" });
    const notified = { ...record, conflict: { notifiedHeadSha: "head-1" } };

    expect(observePullRequest(record, conflicting)).toMatchObject({ newConflict: true });
    expect(observePullRequest(notified, conflicting)).toMatchObject({ newConflict: false });
    expect(
      observePullRequest(notified, pullRequest({ mergeable: "CONFLICTING", headSha: "head-2" })),
    ).toMatchObject({ newConflict: true });
    expect(observePullRequest(record, pullRequest({ mergeable: "MERGEABLE" }))).toMatchObject({
      newConflict: false,
    });
  });
});

describe("selectNewReviewComments", () => {
  const after = Date.parse("2026-10-17T00:00:00.000Z") + 60_000;

  function comment(id: string, overrides: Partial<PullRequestTimelineItem> = {}) {
    return {
      kind: "comment",
      id,
      author: "maintainer",
      authorUrl: null,
      avatarUrl: null,
      body: "Please rename this.",
      createdAt: after,
      url: `https://github.com/acme/widgets/pull/42#${id}`,
      authorAssociation: "MEMBER",
      ...overrides,
    } as PullRequestTimelineItem;
  }

  test("keeps comments from people with repo access and allowed bots", () => {
    const items = [
      comment("owner", { authorAssociation: "OWNER" }),
      comment("member"),
      comment("collaborator", { authorAssociation: "COLLABORATOR" }),
      comment("copilot", {
        author: "copilot-pull-request-reviewer",
        authorIsBot: true,
        authorAssociation: "NONE",
      }),
    ];

    expect(selectNewReviewComments(watchRecord(), items).map((item) => item.id)).toEqual([
      "owner",
      "member",
      "collaborator",
      "copilot",
    ]);
  });

  test("drops outsiders, other bots, the agent's own replies, and old or seen comments", () => {
    const record = watchRecord();
    const items = [
      comment("outsider", { authorAssociation: "CONTRIBUTOR" }),
      comment("unknown-association", { authorAssociation: undefined }),
      comment("other-bot", { author: "renovate", authorIsBot: true }),
      comment("own-reply", { body: `Fixed in abc123.\n${PR_WATCH_COMMENT_MARKER}` }),
      comment("before-watch", { createdAt: after - 120_000 }),
      comment("seen"),
      comment("empty", { body: "  " }),
    ];

    expect(
      selectNewReviewComments(
        { ...record, review: { ...record.review, seenCommentIds: ["seen"] } },
        items,
      ),
    ).toEqual([]);
  });

  test("drops resolved and outdated threads and approvals", () => {
    const items = [
      comment("resolved", { location: { path: "a.ts", isResolved: true } }),
      comment("outdated", { location: { path: "a.ts", isOutdated: true } }),
      {
        ...comment("approval"),
        kind: "review",
        reviewState: "approved",
        body: "Looks good",
      } as PullRequestTimelineItem,
      {
        ...comment("changes"),
        kind: "review",
        reviewState: "changes_requested",
        body: "Needs a test",
      } as PullRequestTimelineItem,
    ];

    expect(selectNewReviewComments(watchRecord(), items).map((item) => item.id)).toEqual([
      "changes",
    ]);
  });
});
