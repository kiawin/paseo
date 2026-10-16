import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { PullRequestCheck, PullRequestTimelineItem } from "../../services/forge-service.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManagerEvent } from "../agent/agent-manager.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";
import type { PrWatchPullRequest } from "./detect.js";
import { PrWatchService, type PrWatchSendPromptParams } from "./service.js";
import { PrWatchStore, type PrWatchRecord } from "./store.js";

interface AgentRow {
  id: string;
  cwd: string;
  workspaceId?: string;
  archivedAt?: string | null;
  labels?: Record<string, string>;
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
    repoOwner: "acme",
    repoName: "widgets",
    checks: [],
    ...overrides,
  };
}

function failed(name: string, checkRunId?: number): PullRequestCheck {
  return { name, status: "failure", url: `https://ci/${name}`, checkRunId };
}

function passed(name: string): PullRequestCheck {
  return { name, status: "success", url: `https://ci/${name}` };
}

function pending(name: string): PullRequestCheck {
  return { name, status: "pending", url: `https://ci/${name}` };
}

function reviewComment(
  id: string,
  overrides: Partial<PullRequestTimelineItem> = {},
): PullRequestTimelineItem {
  return {
    kind: "comment",
    id,
    author: "maintainer",
    authorUrl: null,
    avatarUrl: null,
    body: `Please fix ${id}.`,
    createdAt: Date.now() + 60_000,
    url: `https://github.com/acme/widgets/pull/42#${id}`,
    authorAssociation: "MEMBER",
    ...overrides,
  } as PullRequestTimelineItem;
}

class Harness {
  readonly pullRequests = new Map<string, PrWatchPullRequest | null>();
  readonly listeners = new Map<string, (snapshot: WorkspaceGitRuntimeSnapshot) => void>();
  readonly agents = new Map<string, AgentRow>();
  readonly untrustedWorkspaces = new Set<string>();
  /** Workspace kind by id; agents default to a Paseo worktree. */
  readonly workspaceKinds = new Map<string, string>();
  autoFixAgentPullRequests = false;
  readonly busy = new Set<string>();
  readonly sent: PrWatchSendPromptParams[] = [];
  readonly paused: PrWatchRecord[] = [];
  readonly forges = new Map<string, string>();
  /** Timeline the fake forge returns, by cwd. */
  readonly timelines = new Map<string, PullRequestTimelineItem[]>();
  timelineFetches = 0;
  failNextSend: Error | null = null;
  private agentSubscriber: ((event: AgentManagerEvent) => void) | null = null;
  readonly store: PrWatchStore;
  service: PrWatchService;

  constructor(
    paseoHome: string,
    options: { settleTimeoutMs?: number; maxConcurrentTurns?: number } = {},
  ) {
    this.store = new PrWatchStore(paseoHome, createTestLogger());
    this.service = this.createService(options);
  }

  createService(
    options: { settleTimeoutMs?: number; maxConcurrentTurns?: number } = {},
  ): PrWatchService {
    return new PrWatchService({
      store: this.store,
      logger: createTestLogger(),
      settleTimeoutMs: options.settleTimeoutMs ?? 60_000,
      maxConcurrentTurns: options.maxConcurrentTurns,
      workspaceGitService: {
        registerWorkspace: ({ cwd }, listener) => {
          this.listeners.set(cwd, listener);
          return { unsubscribe: () => this.listeners.delete(cwd) };
        },
        getSnapshot: async (cwd) =>
          ({
            forge: {
              pullRequest: this.pullRequests.get(cwd) ?? null,
              forge: this.forges.get(cwd) ?? "github",
            },
          }) as unknown as WorkspaceGitRuntimeSnapshot,
        resolveForge: async (cwd) =>
          ({
            service: {
              getPullRequestTimeline: async () => {
                this.timelineFetches += 1;
                return { items: this.timelines.get(cwd) ?? [], error: null };
              },
              getCheckDetails: async () => {
                throw new Error("no check details in tests");
              },
            },
          }) as never,
      },
      agentManager: {
        subscribe: (callback) => {
          this.agentSubscriber = callback;
          return () => {
            this.agentSubscriber = null;
          };
        },
        hasInFlightRun: (agentId) => this.busy.has(agentId),
        getAgent: () => undefined,
      },
      agentStorage: {
        get: async (agentId) => {
          const row = this.agents.get(agentId);
          return row ? ({ ...row, archivedAt: row.archivedAt ?? null } as never) : null;
        },
      },
      workspaceRegistry: {
        get: async (workspaceId) =>
          ({
            projectId: "project-1",
            kind: this.workspaceKinds.get(workspaceId) ?? "worktree",
            untrustedSource: this.untrustedWorkspaces.has(workspaceId)
              ? { kind: "change_request", forge: "github", number: 1, headRepository: "fork/x" }
              : undefined,
          }) as never,
      },
      projectRegistry: {
        get: async () =>
          ({
            prAutomation: {
              autoReview: false,
              reviewProvider: null,
              postReviews: false,
              autoFixAgentPullRequests: this.autoFixAgentPullRequests,
            },
          }) as never,
      },
      sendPrompt: async (params) => {
        if (this.failNextSend) {
          const error = this.failNextSend;
          this.failNextSend = null;
          throw error;
        }
        if (this.busy.has(params.agentId)) throw new Error("already has an active run");
        this.sent.push(params);
        this.busy.add(params.agentId);
      },
      onWatchPaused: (record) => this.paused.push(record),
    });
  }

  addAgent(id: string, cwd = `/repo/${id}`, workspaceId = `ws-${id}`): void {
    this.agents.set(id, { id, cwd, workspaceId });
    this.pullRequests.set(cwd, pullRequest());
  }

  async poll(agentId: string, overrides: Partial<PrWatchPullRequest>): Promise<void> {
    const cwd = this.agents.get(agentId)!.cwd;
    const pr = pullRequest(overrides);
    this.pullRequests.set(cwd, pr);
    this.listeners.get(cwd)?.({
      forge: { pullRequest: pr },
    } as unknown as WorkspaceGitRuntimeSnapshot);
    await this.service.whenIdle();
  }

  async finishTurn(agentId: string): Promise<void> {
    this.busy.delete(agentId);
    this.agentSubscriber?.({
      type: "agent_state",
      agent: { id: agentId },
    } as unknown as AgentManagerEvent);
    await this.service.whenIdle();
  }
}

describe("PrWatchService", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-pr-watch-service-"));
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function started(options?: { settleTimeoutMs?: number; maxConcurrentTurns?: number }) {
    const harness = new Harness(paseoHome, options);
    await harness.service.start();
    return harness;
  }

  test("sends one prompt for a head's failures once its checks finish", async () => {
    const harness = await started();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });

    await harness.poll("a1", { checks: [failed("lint", 1), pending("test")] });
    expect(harness.sent).toHaveLength(0);

    await harness.poll("a1", { checks: [failed("lint", 1), failed("test", 2)] });
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      agentId: "a1",
      source: { kind: "forge-event", agentId: "pr-watch:a1", title: "PR #42 auto-fix" },
    });
    expect(harness.sent[0]?.prompt).toContain("- lint https://ci/lint");
    expect(harness.sent[0]?.prompt).toContain("- test https://ci/test");

    await harness.finishTurn("a1");
    await harness.poll("a1", { checks: [failed("lint", 1), failed("test", 2)] });
    expect(harness.sent).toHaveLength(1);
  });

  test("stops waiting for running checks after the settle timeout", async () => {
    const harness = await started({ settleTimeoutMs: 30 });
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });

    await harness.poll("a1", { checks: [failed("lint", 1), pending("slow")] });
    expect(harness.sent).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await harness.service.whenIdle();
    expect(harness.sent).toHaveLength(1);
  });

  test("holds failures while the agent is busy and sends them together after its turn", async () => {
    const harness = await started();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });
    harness.busy.add("a1");

    await harness.poll("a1", { checks: [failed("lint", 1), passed("test")] });
    await harness.poll("a1", { checks: [failed("lint", 1), failed("build", 3)] });
    expect(harness.sent).toHaveLength(0);

    await harness.finishTurn("a1");
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.prompt).toContain("- lint");
    expect(harness.sent[0]?.prompt).toContain("- build");
  });

  test("keeps failures for later when a send collides with a turn the user started", async () => {
    const harness = await started();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });
    harness.failNextSend = new Error("Agent a1 already has an active run");

    await harness.poll("a1", { checks: [failed("lint", 1)] });
    expect(harness.sent).toHaveLength(0);

    await harness.finishTurn("a1");
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.prompt).toContain("- lint");
  });

  test("runs at most the configured number of auto-fix turns at once", async () => {
    const harness = await started({ maxConcurrentTurns: 2 });
    for (const id of ["a1", "a2", "a3"]) {
      harness.addAgent(id);
      await harness.service.setWatch({ agentId: id, enabled: true });
    }

    for (const id of ["a1", "a2", "a3"]) await harness.poll(id, { checks: [failed("lint", 1)] });
    expect(harness.sent.map((send) => send.agentId)).toEqual(["a1", "a2"]);

    await harness.finishTurn("a1");
    expect(harness.sent.map((send) => send.agentId)).toEqual(["a1", "a2", "a3"]);
  });

  test("pauses after the attempt limit for one head and reports it", async () => {
    const harness = await started();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });

    for (let run = 1; run <= 4; run += 1) {
      await harness.poll("a1", { checks: [failed(`check-${run}`)] });
      await harness.finishTurn("a1");
    }

    expect(harness.sent).toHaveLength(3);
    expect((await harness.store.get("a1"))?.state).toMatchObject({
      kind: "paused",
      reason: "attempt_limit",
    });
    expect(harness.paused.map((record) => record.agentId)).toEqual(["a1"]);
    expect(harness.listeners.has("/repo/a1")).toBe(false);
  });

  test("pauses when fix pushes keep producing failing heads", async () => {
    const harness = await started();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });

    for (let head = 1; head <= 4; head += 1) {
      await harness.poll("a1", { headSha: `head-${head}`, checks: [failed("lint", head)] });
      await harness.finishTurn("a1");
    }

    expect(harness.sent).toHaveLength(3);
    expect((await harness.store.get("a1"))?.state).toMatchObject({ kind: "paused" });
  });

  test("a green head resets the failing-heads count", async () => {
    const harness = await started();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });

    await harness.poll("a1", { headSha: "head-1", checks: [failed("lint", 1)] });
    await harness.finishTurn("a1");
    await harness.poll("a1", { headSha: "head-2", checks: [passed("lint")] });

    expect((await harness.store.get("a1"))?.ci.consecutiveFailedHeads).toBe(0);
  });

  test("stops when the PR merges and stops polling its folder", async () => {
    const harness = await started();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });

    await harness.poll("a1", { isMerged: true, state: "merged" });

    expect((await harness.store.get("a1"))?.state).toMatchObject({
      kind: "stopped",
      reason: "merged",
    });
    expect(harness.listeners.has("/repo/a1")).toBe(false);
  });

  test("stops for an archived agent and removes the watch of a deleted one", async () => {
    const harness = await started();
    harness.addAgent("archived");
    harness.addAgent("deleted");
    await harness.service.setWatch({ agentId: "archived", enabled: true });
    await harness.service.setWatch({ agentId: "deleted", enabled: true });
    harness.agents.get("archived")!.archivedAt = "2026-10-17T00:00:00.000Z";
    harness.agents.delete("deleted");
    harness.pullRequests.set("/repo/deleted", pullRequest());

    await harness.poll("archived", { checks: [failed("lint", 1)] });
    harness.listeners.get("/repo/deleted")?.({
      forge: { pullRequest: pullRequest({ checks: [failed("lint", 1)] }) },
    } as unknown as WorkspaceGitRuntimeSnapshot);
    await harness.service.whenIdle();

    expect(harness.sent).toHaveLength(0);
    expect((await harness.store.get("archived"))?.state).toMatchObject({
      kind: "stopped",
      reason: "agent_archived",
    });
    expect(await harness.store.get("deleted")).toBeNull();
  });

  test("pauses instead of prompting an agent in an untrusted fork-PR workspace", async () => {
    const harness = await started();
    harness.addAgent("a1");
    harness.untrustedWorkspaces.add("ws-a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });

    await harness.poll("a1", { checks: [failed("lint", 1)] });

    expect(harness.sent).toHaveLength(0);
    expect((await harness.store.get("a1"))?.state).toMatchObject({
      kind: "paused",
      reason: "untrusted_workspace",
    });
  });

  test("after a restart, a failure already sent is not sent again", async () => {
    const harness = await started();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });
    await harness.poll("a1", { checks: [failed("lint", 1)] });
    await harness.finishTurn("a1");
    harness.service.stop();

    harness.service = harness.createService();
    await harness.service.start();
    await harness.poll("a1", { checks: [failed("lint", 1)] });

    expect(harness.sent).toHaveLength(1);
  });

  test("refuses to watch a branch with no open PR or on an unsupported forge", async () => {
    const harness = await started();
    harness.addAgent("no-pr");
    harness.pullRequests.set("/repo/no-pr", null);
    harness.addAgent("gitea");
    harness.forges.set("/repo/gitea", "gitea");

    await expect(harness.service.setWatch({ agentId: "no-pr", enabled: true })).rejects.toThrow(
      "no open pull request",
    );
    await expect(harness.service.setWatch({ agentId: "gitea", enabled: true })).rejects.toThrow(
      "GitHub and GitLab",
    );
  });

  test("turning a watch off stops it", async () => {
    const harness = await started();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });

    const record = await harness.service.setWatch({ agentId: "a1", enabled: false });

    expect(record?.state).toMatchObject({ kind: "stopped", reason: "user_disabled" });
    expect(harness.listeners.has("/repo/a1")).toBe(false);
  });
});

describe("PrWatchService review comments and conflicts", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-pr-watch-review-"));
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function watching() {
    const harness = new Harness(paseoHome);
    await harness.service.start();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });
    return harness;
  }

  test("sends new review comments after PR activity, once each", async () => {
    const harness = await watching();
    harness.timelines.set("/repo/a1", [
      reviewComment("c1"),
      reviewComment("outsider", { authorAssociation: "NONE" }),
    ]);

    await harness.poll("a1", { updatedAt: "2026-10-17T01:00:00Z" });

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.prompt).toContain("Please fix c1.");
    expect(harness.sent[0]?.prompt).not.toContain("outsider");

    await harness.finishTurn("a1");
    harness.timelines.get("/repo/a1")!.push(reviewComment("c2"));
    await harness.poll("a1", { updatedAt: "2026-10-17T01:05:00Z" });

    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]?.prompt).toContain("Please fix c2.");
    expect(harness.sent[1]?.prompt).not.toContain("Please fix c1.");
    expect((await harness.store.get("a1"))?.review.seenCommentIds).toEqual(["c1", "c2"]);
  });

  test("reads the timeline only when the PR's activity time moves", async () => {
    const harness = await watching();
    const fetchesAfterWatch = harness.timelineFetches;

    await harness.poll("a1", { updatedAt: "2026-10-17T01:00:00Z" });
    await harness.poll("a1", { updatedAt: "2026-10-17T01:00:00Z" });

    expect(harness.timelineFetches).toBe(fetchesAfterWatch + 1);
  });

  test("ignores review comments on GitLab, which reports no author access", async () => {
    const harness = new Harness(paseoHome);
    await harness.service.start();
    harness.addAgent("a1");
    harness.forges.set("/repo/a1", "gitlab");
    await harness.service.setWatch({ agentId: "a1", enabled: true });
    harness.timelines.set("/repo/a1", [reviewComment("c1")]);

    await harness.poll("a1", { updatedAt: "2026-10-17T01:00:00Z" });

    expect(harness.sent).toHaveLength(0);
    expect(harness.timelineFetches).toBe(0);
  });

  test("sends a comment without waiting for checks still running", async () => {
    const harness = await watching();
    harness.timelines.set("/repo/a1", [reviewComment("c1")]);

    await harness.poll("a1", {
      updatedAt: "2026-10-17T01:00:00Z",
      checks: [failed("lint", 1), pending("test")],
    });

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.prompt).toContain("Please fix c1.");
    expect(harness.sent[0]?.prompt).not.toContain("CI failed");

    await harness.finishTurn("a1");
    await harness.poll("a1", { checks: [failed("lint", 1), passed("test")] });
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]?.prompt).toContain("- lint https://ci/lint");
  });

  test("reports a merge conflict once per head", async () => {
    const harness = await watching();

    await harness.poll("a1", { mergeable: "CONFLICTING" });
    await harness.finishTurn("a1");
    await harness.poll("a1", { mergeable: "CONFLICTING" });

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.prompt).toContain("conflicts with its base branch `main`");

    await harness.poll("a1", { headSha: "head-2", mergeable: "CONFLICTING" });
    expect(harness.sent).toHaveLength(2);
    expect((await harness.store.get("a1"))?.conflict.notifiedHeadSha).toBe("head-2");
  });
});

describe("PrWatchService watches for PRs agents open", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-pr-watch-auto-"));
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function settled(harness: Harness, agentId: string): Promise<void> {
    await harness.finishTurn(agentId);
    // The check runs outside the per-watch lock; let it finish.
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    await harness.service.whenIdle();
  }

  test("watches the PR when the agent's turn ends and the project opts in", async () => {
    const harness = new Harness(paseoHome);
    await harness.service.start();
    harness.autoFixAgentPullRequests = true;
    harness.addAgent("a1");

    await settled(harness, "a1");

    expect((await harness.store.get("a1"))?.state).toEqual({ kind: "active" });
    expect(harness.listeners.has("/repo/a1")).toBe(true);
  });

  test("leaves PRs alone when the setting is off, outside a worktree, or for reviewers", async () => {
    const harness = new Harness(paseoHome);
    await harness.service.start();
    harness.addAgent("off");
    await settled(harness, "off");
    harness.autoFixAgentPullRequests = true;
    harness.addAgent("main-checkout");
    harness.workspaceKinds.set("ws-main-checkout", "local_checkout");
    harness.addAgent("reviewer");
    harness.agents.get("reviewer")!.labels = { "paseo.pr-review": "https://github.com/x/y/pull/1" };
    harness.addAgent("no-pr");
    harness.pullRequests.set("/repo/no-pr", null);

    for (const id of ["main-checkout", "reviewer", "no-pr"]) await settled(harness, id);

    expect(await harness.store.list()).toEqual([]);
  });

  test("doesn't restart a watch the user turned off", async () => {
    const harness = new Harness(paseoHome);
    await harness.service.start();
    harness.autoFixAgentPullRequests = true;
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });
    await harness.service.setWatch({ agentId: "a1", enabled: false });

    await settled(harness, "a1");

    expect((await harness.store.get("a1"))?.state).toMatchObject({
      kind: "stopped",
      reason: "user_disabled",
    });
  });
});

describe("PrWatchService failure identity", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-pr-watch-identity-"));
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("does not resend a failure when a later poll adds its check-run id", async () => {
    const harness = new Harness(paseoHome);
    await harness.service.start();
    harness.addAgent("a1");
    await harness.service.setWatch({ agentId: "a1", enabled: true });

    await harness.poll("a1", { checks: [failed("test")] });
    await harness.finishTurn("a1");
    await harness.poll("a1", { checks: [failed("test", 117)] });

    expect(harness.sent).toHaveLength(1);
  });
});
