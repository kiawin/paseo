import { describe, expect, it } from "vitest";
import type { PrWatchPayload } from "@getpaseo/protocol/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  classifyPullRequest,
  collectPullRequestRows,
  describeAutoFixPause,
  describePullRequestBadges,
  groupPullRequestRows,
  resolveAutoFixBinding,
  type PullRequestAgentOption,
  type PullRequestRow,
} from "./pull-request-rows";

type PullRequest = NonNullable<NonNullable<WorkspaceDescriptor["githubRuntime"]>["pullRequest"]>;

function workspace(
  id: string,
  pullRequest: Partial<PullRequest> | null,
  overrides: Partial<WorkspaceDescriptor> = {},
): WorkspaceDescriptor {
  return {
    id,
    projectId: "proj",
    projectDisplayName: "paseo",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    title: null,
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    forge: "github",
    githubRuntime: {
      featuresEnabled: true,
      pullRequest: pullRequest
        ? {
            number: 12,
            url: "https://github.com/getpaseo/paseo/pull/12",
            title: "Fix the thing",
            state: "open",
            baseRefName: "main",
            headRefName: id,
            isMerged: false,
            repoOwner: "getpaseo",
            repoName: "paseo",
            ...pullRequest,
          }
        : null,
      error: null,
    },
    ...overrides,
  };
}

function row(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    key: "srv:ws",
    serverId: "srv",
    serverName: "Laptop",
    workspaceId: "ws",
    workspaceName: "ws",
    forge: "github",
    number: 1,
    url: "https://github.com/getpaseo/paseo/pull/1",
    title: "Change",
    repoLabel: "getpaseo/paseo",
    isDraft: false,
    mergeable: "MERGEABLE",
    checksStatus: "success",
    reviewDecision: "pending",
    agents: [],
    ...overrides,
  };
}

function watch(agentId: string, state: PrWatchPayload["state"]): PrWatchPayload {
  return {
    agentId,
    cwd: "/repo/ws",
    forge: "github",
    prNumber: 12,
    prUrl: "https://github.com/getpaseo/paseo/pull/12",
    state,
    headSha: "abc123",
    attemptsForHead: 0,
    maxAttemptsPerHead: 3,
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
}

const alpha: PullRequestAgentOption = { agentId: "alpha", title: "Alpha" };
const beta: PullRequestAgentOption = { agentId: "beta", title: "Beta" };

describe("collectPullRequestRows", () => {
  it("keeps open unmerged PRs and drops merged, closed, archiving, and PR-less workspaces", () => {
    const rows = collectPullRequestRows([
      {
        serverId: "srv",
        serverName: "Laptop",
        workspaces: [
          workspace("open", {}),
          workspace("merged", { isMerged: true, state: "merged" }),
          workspace("closed", { state: "closed" }),
          workspace("archiving", {}, { archivingAt: "2026-10-17T00:00:00.000Z" }),
          workspace("none", null),
        ],
        agentsByWorkspaceId: new Map([["open", [alpha]]]),
      },
    ]);

    expect(rows).toEqual([
      {
        key: "srv:open",
        serverId: "srv",
        serverName: "Laptop",
        workspaceId: "open",
        workspaceName: "open",
        forge: "github",
        number: 12,
        url: "https://github.com/getpaseo/paseo/pull/12",
        title: "Fix the thing",
        repoLabel: "getpaseo/paseo",
        isDraft: false,
        mergeable: null,
        checksStatus: null,
        reviewDecision: null,
        agents: [alpha],
      },
    ]);
  });

  it("collects across hosts and leaves the repo label empty when the owner is unknown", () => {
    const rows = collectPullRequestRows([
      {
        serverId: "a",
        serverName: "A",
        workspaces: [workspace("one", { repoOwner: undefined })],
        agentsByWorkspaceId: new Map(),
      },
      {
        serverId: "b",
        serverName: "B",
        workspaces: [workspace("two", { isDraft: true }, { forge: "gitlab" })],
        agentsByWorkspaceId: new Map(),
      },
    ]);

    expect(rows.map((entry) => [entry.key, entry.repoLabel, entry.forge, entry.isDraft])).toEqual([
      ["a:one", null, "github", false],
      ["b:two", "getpaseo/paseo", "gitlab", true],
    ]);
    expect(rows[0]?.agents).toEqual([]);
  });
});

describe("classifyPullRequest", () => {
  it.each([
    ["failing checks", { checksStatus: "failure" as const }],
    ["changes requested", { reviewDecision: "changes_requested" as const }],
    ["merge conflicts", { mergeable: "CONFLICTING" as const }],
  ])("needs attention for %s", (_label, overrides) => {
    expect(classifyPullRequest(row(overrides), false)).toBe("needs-attention");
  });

  it("needs attention when auto-fix is paused, even if the PR is otherwise ready", () => {
    expect(classifyPullRequest(row({ reviewDecision: "approved" }), true)).toBe("needs-attention");
  });

  it("is ready when approved with checks passing or absent", () => {
    expect(classifyPullRequest(row({ reviewDecision: "approved" }), false)).toBe("ready");
    expect(
      classifyPullRequest(row({ reviewDecision: "approved", checksStatus: "none" }), false),
    ).toBe("ready");
    expect(
      classifyPullRequest(row({ reviewDecision: "approved", checksStatus: null }), false),
    ).toBe("ready");
  });

  it("is in progress for drafts, running checks, and pending or missing reviews", () => {
    expect(classifyPullRequest(row({ reviewDecision: "approved", isDraft: true }), false)).toBe(
      "in-progress",
    );
    expect(
      classifyPullRequest(row({ reviewDecision: "approved", checksStatus: "pending" }), false),
    ).toBe("in-progress");
    expect(classifyPullRequest(row({ reviewDecision: "pending" }), false)).toBe("in-progress");
    expect(classifyPullRequest(row({ reviewDecision: null }), false)).toBe("in-progress");
  });
});

function summarizeSection(section: { id: string; title: string; rows: PullRequestRow[] }) {
  return [section.id, section.title, section.rows.map((entry) => entry.key)];
}

describe("groupPullRequestRows", () => {
  it("returns non-empty sections in order with rows sorted by repo then newest number", () => {
    const rows = [
      row({ key: "1", number: 3, reviewDecision: "approved" }),
      row({ key: "2", number: 7, checksStatus: "failure" }),
      row({ key: "3", number: 9, reviewDecision: "approved", repoLabel: "acme/api" }),
      row({ key: "4", number: 5, reviewDecision: "approved" }),
    ];

    const sections = groupPullRequestRows(rows, (entry) => entry.key === "4");

    expect(sections.map(summarizeSection)).toEqual([
      ["needs-attention", "Needs attention", ["2", "4"]],
      ["ready", "Ready", ["3", "1"]],
    ]);
  });

  it("returns no sections for no rows", () => {
    expect(groupPullRequestRows([], () => false)).toEqual([]);
  });
});

describe("resolveAutoFixBinding", () => {
  const noWatches = new Map<string, PrWatchPayload>();

  it("is unsupported when the host lacks PR auto-fix", () => {
    expect(
      resolveAutoFixBinding({ supported: false, agents: [alpha], watchesByAgentId: noWatches }),
    ).toEqual({ kind: "unsupported" });
  });

  it("has no agent when the workspace has no live root agent", () => {
    expect(
      resolveAutoFixBinding({ supported: true, agents: [], watchesByAgentId: noWatches }),
    ).toEqual({ kind: "no-agent" });
  });

  it("binds a lone agent, off when it has no watch or a stopped one", () => {
    expect(
      resolveAutoFixBinding({ supported: true, agents: [alpha], watchesByAgentId: noWatches }),
    ).toEqual({ kind: "agent", agentId: "alpha", watch: null, enabled: false, pausedReason: null });

    const stopped = watch("alpha", { kind: "stopped", reason: "user_disabled", at: "t" });
    expect(
      resolveAutoFixBinding({
        supported: true,
        agents: [alpha],
        watchesByAgentId: new Map([["alpha", stopped]]),
      }),
    ).toEqual({
      kind: "agent",
      agentId: "alpha",
      watch: stopped,
      enabled: false,
      pausedReason: null,
    });
  });

  it("asks the user to choose among several agents when none is watching", () => {
    expect(
      resolveAutoFixBinding({
        supported: true,
        agents: [alpha, beta],
        watchesByAgentId: noWatches,
      }),
    ).toEqual({ kind: "choose", agents: [alpha, beta] });
  });

  it("binds the watching agent among several, preferring an active watch over a paused one", () => {
    const paused = watch("alpha", { kind: "paused", reason: "attempt_limit", at: "t" });
    const active = watch("beta", { kind: "active" });

    expect(
      resolveAutoFixBinding({
        supported: true,
        agents: [alpha, beta],
        watchesByAgentId: new Map([
          ["alpha", paused],
          ["beta", active],
        ]),
      }),
    ).toMatchObject({ kind: "agent", agentId: "beta", enabled: true, pausedReason: null });

    expect(
      resolveAutoFixBinding({
        supported: true,
        agents: [alpha, beta],
        watchesByAgentId: new Map([["alpha", paused]]),
      }),
    ).toMatchObject({
      kind: "agent",
      agentId: "alpha",
      enabled: false,
      pausedReason: "attempt_limit",
    });
  });
});

describe("describeAutoFixPause", () => {
  it("names known reasons in plain words and falls back for unknown ones", () => {
    expect(describeAutoFixPause("attempt_limit")).toBe("Paused — attempt limit reached");
    expect(describeAutoFixPause("untrusted_workspace")).toBe("Paused — workspace is not trusted");
    expect(describeAutoFixPause("rate_limited_by_forge")).toBe("Paused — rate limited by forge");
  });
});

describe("describePullRequestBadges", () => {
  it("lists draft, conflicts, checks, and review in that order", () => {
    expect(
      describePullRequestBadges(
        row({
          isDraft: true,
          mergeable: "CONFLICTING",
          checksStatus: "failure",
          reviewDecision: "changes_requested",
        }),
      ),
    ).toEqual([
      { label: "Draft", variant: "muted" },
      { label: "Conflicts", variant: "error" },
      { label: "Checks failing", variant: "error" },
      { label: "Changes requested", variant: "error" },
    ]);
  });

  it("omits absent signals", () => {
    expect(
      describePullRequestBadges(
        row({ checksStatus: "none", reviewDecision: null, mergeable: "UNKNOWN" }),
      ),
    ).toEqual([]);
    expect(
      describePullRequestBadges(row({ checksStatus: "pending", reviewDecision: "approved" })),
    ).toEqual([
      { label: "Checks running", variant: "warning" },
      { label: "Approved", variant: "success" },
    ]);
  });
});
