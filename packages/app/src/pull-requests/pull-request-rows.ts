import type { PrWatchPayload } from "@getpaseo/protocol/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";

type WorkspacePullRequest = NonNullable<
  NonNullable<WorkspaceDescriptor["githubRuntime"]>["pullRequest"]
>;

/** A root agent that could own a PR auto-fix watch for its workspace. */
export interface PullRequestAgentOption {
  agentId: string;
  title: string | null;
}

/** One host's workspaces plus the root agents in each, as the session store holds them. */
export interface PullRequestSourceHost {
  serverId: string;
  serverName: string;
  workspaces: Iterable<WorkspaceDescriptor>;
  /** Non-archived root agents per workspace id, most recently active first. */
  agentsByWorkspaceId: ReadonlyMap<string, readonly PullRequestAgentOption[]>;
}

/** One open pull request, keyed by the workspace whose branch it belongs to. */
export interface PullRequestRow {
  key: string;
  serverId: string;
  serverName: string;
  workspaceId: string;
  workspaceName: string;
  forge: string;
  number: number | null;
  url: string;
  title: string;
  repoLabel: string | null;
  isDraft: boolean;
  mergeable: WorkspacePullRequest["mergeable"] | null;
  checksStatus: WorkspacePullRequest["checksStatus"] | null;
  reviewDecision: WorkspacePullRequest["reviewDecision"] | null;
  agents: readonly PullRequestAgentOption[];
}

const NO_AGENTS: readonly PullRequestAgentOption[] = [];

/**
 * Every open, unmerged pull request across the given hosts. A workspace without a
 * PR, or one being archived, contributes nothing.
 */
export function collectPullRequestRows(hosts: readonly PullRequestSourceHost[]): PullRequestRow[] {
  const rows: PullRequestRow[] = [];
  for (const host of hosts) {
    for (const workspace of host.workspaces) {
      const pullRequest = workspace.githubRuntime?.pullRequest;
      if (!pullRequest || workspace.archivingAt) continue;
      if (pullRequest.isMerged || pullRequest.state !== "open") continue;
      const repoLabel =
        pullRequest.repoOwner && pullRequest.repoName
          ? `${pullRequest.repoOwner}/${pullRequest.repoName}`
          : null;
      rows.push({
        key: `${host.serverId}:${workspace.id}`,
        serverId: host.serverId,
        serverName: host.serverName,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        forge: workspace.forge ?? "github",
        number: pullRequest.number ?? null,
        url: pullRequest.url,
        title: pullRequest.title,
        repoLabel,
        isDraft: pullRequest.isDraft === true,
        mergeable: pullRequest.mergeable ?? null,
        checksStatus: pullRequest.checksStatus ?? null,
        reviewDecision: pullRequest.reviewDecision ?? null,
        agents: host.agentsByWorkspaceId.get(workspace.id) ?? NO_AGENTS,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Auto-fix binding: which agent a row's switch acts on.
// ---------------------------------------------------------------------------

export type AutoFixBinding =
  /** The host does not run PR auto-fix. */
  | { kind: "unsupported" }
  /** No live root agent in the workspace, so there is nothing to watch with. */
  | { kind: "no-agent" }
  /** The switch acts on this agent. */
  | {
      kind: "agent";
      agentId: string;
      watch: PrWatchPayload | null;
      enabled: boolean;
      pausedReason: string | null;
    }
  /** Several agents and none is watching yet: the user picks one before turning it on. */
  | { kind: "choose"; agents: readonly PullRequestAgentOption[] };

function agentBinding(agentId: string, watch: PrWatchPayload | null): AutoFixBinding {
  return {
    kind: "agent",
    agentId,
    watch,
    enabled: watch?.state.kind === "active",
    pausedReason: watch?.state.kind === "paused" ? watch.state.reason : null,
  };
}

/**
 * An agent that already watches the PR wins (active before paused), so turning the
 * switch off always reaches the watch that is running. Otherwise a lone agent is the
 * target, and several agents mean the user has to choose.
 */
export function resolveAutoFixBinding(input: {
  supported: boolean;
  agents: readonly PullRequestAgentOption[];
  watchesByAgentId: ReadonlyMap<string, PrWatchPayload>;
}): AutoFixBinding {
  if (!input.supported) return { kind: "unsupported" };
  if (input.agents.length === 0) return { kind: "no-agent" };

  for (const kind of ["active", "paused"] as const) {
    for (const agent of input.agents) {
      const watch = input.watchesByAgentId.get(agent.agentId);
      if (watch?.state.kind === kind) return agentBinding(agent.agentId, watch);
    }
  }

  const [onlyAgent] = input.agents;
  if (input.agents.length === 1 && onlyAgent) {
    return agentBinding(onlyAgent.agentId, input.watchesByAgentId.get(onlyAgent.agentId) ?? null);
  }
  return { kind: "choose", agents: input.agents };
}

const PAUSE_REASON_LABELS: Record<string, string> = {
  attempt_limit: "attempt limit reached",
  untrusted_workspace: "workspace is not trusted",
};

/** Plain words for a paused watch. Reasons are open strings, so unknown ones fall back to the raw value. */
export function describeAutoFixPause(reason: string): string {
  const label = PAUSE_REASON_LABELS[reason] ?? reason.replaceAll("_", " ");
  return `Paused — ${label}`;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export interface PullRequestBadge {
  label: string;
  variant: "success" | "warning" | "error" | "muted";
}

const CHECKS_BADGES: Record<string, PullRequestBadge> = {
  failure: { label: "Checks failing", variant: "error" },
  pending: { label: "Checks running", variant: "warning" },
  success: { label: "Checks passing", variant: "success" },
};

const REVIEW_BADGES: Record<string, PullRequestBadge> = {
  changes_requested: { label: "Changes requested", variant: "error" },
  approved: { label: "Approved", variant: "success" },
  pending: { label: "Review pending", variant: "muted" },
};

/** Status pills for a row: draft, conflicts, checks, then review. Absent signals add nothing. */
export function describePullRequestBadges(
  row: Pick<PullRequestRow, "checksStatus" | "reviewDecision" | "mergeable" | "isDraft">,
): PullRequestBadge[] {
  const badges: PullRequestBadge[] = [];
  if (row.isDraft) badges.push({ label: "Draft", variant: "muted" });
  if (row.mergeable === "CONFLICTING") badges.push({ label: "Conflicts", variant: "error" });
  const checks = row.checksStatus ? CHECKS_BADGES[row.checksStatus] : undefined;
  if (checks) badges.push(checks);
  const review = row.reviewDecision ? REVIEW_BADGES[row.reviewDecision] : undefined;
  if (review) badges.push(review);
  return badges;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type PullRequestSectionId = "needs-attention" | "in-progress" | "ready";

export const PULL_REQUEST_SECTION_TITLES: Record<PullRequestSectionId, string> = {
  "needs-attention": "Needs attention",
  "in-progress": "In progress",
  ready: "Ready",
};

const SECTION_ORDER: readonly PullRequestSectionId[] = ["needs-attention", "in-progress", "ready"];

/**
 * - Needs attention: failing checks, changes requested, merge conflicts, or a paused auto-fix.
 * - Ready: not a draft, approved, and checks passing or absent.
 * - In progress: everything else — drafts, running checks, a review still pending.
 */
export function classifyPullRequest(
  row: Pick<PullRequestRow, "checksStatus" | "reviewDecision" | "mergeable" | "isDraft">,
  autoFixPaused: boolean,
): PullRequestSectionId {
  if (
    autoFixPaused ||
    row.checksStatus === "failure" ||
    row.reviewDecision === "changes_requested" ||
    row.mergeable === "CONFLICTING"
  ) {
    return "needs-attention";
  }
  const checksClear =
    row.checksStatus === "success" || row.checksStatus === "none" || row.checksStatus === null;
  if (!row.isDraft && row.reviewDecision === "approved" && checksClear) {
    return "ready";
  }
  return "in-progress";
}

export interface PullRequestSection<T> {
  id: PullRequestSectionId;
  title: string;
  rows: T[];
}

function compareRows(left: PullRequestRow, right: PullRequestRow): number {
  const repo = (left.repoLabel ?? "").localeCompare(right.repoLabel ?? "");
  if (repo !== 0) return repo;
  const number = (right.number ?? 0) - (left.number ?? 0);
  if (number !== 0) return number;
  return left.key.localeCompare(right.key);
}

/** Non-empty sections in display order; rows sorted by repository, newest PR first. */
export function groupPullRequestRows<T extends PullRequestRow>(
  rows: readonly T[],
  isAutoFixPaused: (row: T) => boolean,
): PullRequestSection<T>[] {
  const buckets = new Map<PullRequestSectionId, T[]>();
  for (const row of rows) {
    const id = classifyPullRequest(row, isAutoFixPaused(row));
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }
  return SECTION_ORDER.flatMap((id) => {
    const bucket = buckets.get(id);
    if (!bucket) return [];
    return [{ id, title: PULL_REQUEST_SECTION_TITLES[id], rows: bucket.sort(compareRows) }];
  });
}
