import { describe, expect, test } from "vitest";

import type { PullRequestCheck } from "../../services/forge-service.js";
import { ciFailureKey, observePullRequest, type PrWatchPullRequest } from "./detect.js";
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
      newFailures: [{ key: "check-run:7", check: failed }],
      checksSettled: true,
    });
  });

  test("skips failures already sent for the same head", () => {
    const observation = observePullRequest(
      watchRecord({ headSha: "head-1", seenFailureKeys: ["check-run:7"] }),
      pullRequest({ checks: [check({ status: "failure", checkRunId: 7 })] }),
    );

    expect(observation).toMatchObject({ kind: "open", newFailures: [] });
  });

  test("treats every failure on a new head as new", () => {
    const observation = observePullRequest(
      watchRecord({ headSha: "head-1", seenFailureKeys: ["status:head-1::test"] }),
      pullRequest({ headSha: "head-2", checks: [check({ status: "failure" })] }),
    );

    expect(observation).toMatchObject({
      kind: "open",
      headChanged: true,
      newFailures: [{ key: "status:head-2::test" }],
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
  test("uses the check run id when the forge reports one", () => {
    expect(ciFailureKey(check({ checkRunId: 9 }), "head-1")).toBe("check-run:9");
  });

  test("falls back to head, workflow and name for status contexts", () => {
    expect(ciFailureKey(check({ workflow: "CI", name: "build" }), "head-1")).toBe(
      "status:head-1:CI:build",
    );
  });
});
