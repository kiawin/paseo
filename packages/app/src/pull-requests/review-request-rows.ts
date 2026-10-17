import type { PrReviewPayload, ReviewRequestPayload } from "@getpaseo/protocol/messages";
import type { PullRequestBadge } from "@/pull-requests/pull-request-rows";

/** A project whose review requests the daemon could not read, with its reason. */
export interface ReviewRequestProjectError {
  projectId: string;
  message: string;
}

/** One host's answer to `listReviewRequests`, plus the project names the session store holds. */
export interface ReviewRequestSourceHost {
  serverId: string;
  serverName: string;
  reviewRequests: readonly ReviewRequestPayload[];
  errors: readonly ReviewRequestProjectError[];
  projectNames: ReadonlyMap<string, string>;
}

export type ReviewRequestAction =
  /** A reviewer is already working in this workspace. */
  | { kind: "open"; workspaceId: string }
  /** No live reviewer: starting one creates its worktree and agent. */
  | { kind: "review" };

/** A host that has the pull request's project, so it can run the reviewer. */
export interface ReviewRequestTarget {
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string | null;
}

/** The reviewer already working on the pull request, and the host it runs on. */
export interface ActiveReview {
  target: ReviewRequestTarget;
  workspaceId: string;
}

/**
 * One pull request someone asked you to review. A project added on several hosts makes
 * each host report the same request, so rows group by pull request URL and list the
 * hosts as targets. One review is enough: you pick the host that runs it.
 */
export interface ReviewRequestRow {
  key: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  isDraft: boolean;
  isFork: boolean;
  updatedAt: string;
  /** Every host that can review this pull request, ordered by host name. */
  targets: ReviewRequestTarget[];
  /** Set when a reviewer is working on it on any host; the newest one wins. */
  activeReview: ActiveReview | null;
}

/** An archived review, or one whose workspace is gone, starts over. */
export function resolveReviewAction(review: PrReviewPayload | null): ReviewRequestAction {
  if (review && review.state === "active" && review.workspaceId !== null) {
    return { kind: "open", workspaceId: review.workspaceId };
  }
  return { kind: "review" };
}

function compareRows(left: ReviewRequestRow, right: ReviewRequestRow): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  if (updated !== 0) return updated;
  return left.key.localeCompare(right.key);
}

function compareTargets(left: ReviewRequestTarget, right: ReviewRequestTarget): number {
  const name = left.serverName.localeCompare(right.serverName);
  if (name !== 0) return name;
  return left.serverId.localeCompare(right.serverId);
}

interface RowDraft {
  request: ReviewRequestPayload;
  targets: ReviewRequestTarget[];
  activeReview: ActiveReview | null;
  activeReviewUpdatedAt: string;
}

/** Every review request across the given hosts, one row per pull request, most recently updated first. */
export function collectReviewRequestRows(
  hosts: readonly ReviewRequestSourceHost[],
): ReviewRequestRow[] {
  const drafts = new Map<string, RowDraft>();
  for (const host of hosts) {
    for (const request of host.reviewRequests) {
      const target: ReviewRequestTarget = {
        serverId: host.serverId,
        serverName: host.serverName,
        projectId: request.projectId,
        projectName: host.projectNames.get(request.projectId) ?? null,
      };
      let draft = drafts.get(request.url);
      if (!draft) {
        draft = { request, targets: [], activeReview: null, activeReviewUpdatedAt: "" };
        drafts.set(request.url, draft);
      } else if (request.updatedAt > draft.request.updatedAt) {
        draft.request = request;
      }
      draft.targets.push(target);
      const action = resolveReviewAction(request.review);
      if (
        action.kind === "open" &&
        request.review &&
        request.review.updatedAt > draft.activeReviewUpdatedAt
      ) {
        draft.activeReview = { target, workspaceId: action.workspaceId };
        draft.activeReviewUpdatedAt = request.review.updatedAt;
      }
    }
  }
  const rows: ReviewRequestRow[] = [];
  for (const { request, targets, activeReview } of drafts.values()) {
    rows.push({
      key: request.url,
      number: request.number,
      title: request.title,
      url: request.url,
      author: request.author,
      isDraft: request.isDraft,
      isFork: request.isCrossRepository,
      updatedAt: request.updatedAt,
      targets: targets.sort(compareTargets),
      activeReview,
    });
  }
  return rows.sort(compareRows);
}

/** Fork and draft PRs are never reviewed automatically, so the row says why it waits for you. */
export function describeReviewRequestBadges(
  row: Pick<ReviewRequestRow, "isFork" | "isDraft">,
): PullRequestBadge[] {
  const badges: PullRequestBadge[] = [];
  if (row.isFork) badges.push({ label: "Fork", variant: "muted" });
  if (row.isDraft) badges.push({ label: "Draft", variant: "muted" });
  return badges;
}

/**
 * `#12 · author · project`, with the hosts appended when more than one is connected:
 * the reviewing host once a review runs, otherwise every host that can review.
 */
export function buildReviewRequestMeta(row: ReviewRequestRow, showHostLabel: boolean): string {
  const parts = [`#${row.number}`];
  if (row.author) parts.push(row.author);
  const projectName =
    row.activeReview?.target.projectName ??
    row.targets.find((target) => target.projectName !== null)?.projectName ??
    null;
  if (projectName) parts.push(projectName);
  if (showHostLabel) {
    const hosts = row.activeReview ? [row.activeReview.target] : row.targets;
    parts.push(hosts.map((target) => target.serverName).join(", "));
  }
  return parts.join(" · ");
}

export interface ReviewRequestHostError {
  serverId: string;
  serverName: string;
}

export interface ReviewRequestErrorLine {
  key: string;
  text: string;
}

/**
 * One line per host and reason. A missing `gh` login fails every project on the host
 * with the same message, so those collapse into one line naming the projects.
 */
export function describeReviewRequestErrors(input: {
  hosts: readonly ReviewRequestSourceHost[];
  hostErrors: readonly ReviewRequestHostError[];
}): ReviewRequestErrorLine[] {
  const lines: ReviewRequestErrorLine[] = input.hostErrors.map((error) => ({
    key: error.serverId,
    text: `${error.serverName}: Could not load review requests`,
  }));
  for (const host of input.hosts) {
    const projectsByMessage = new Map<string, string[]>();
    for (const error of host.errors) {
      const name = host.projectNames.get(error.projectId) ?? error.projectId;
      const projects = projectsByMessage.get(error.message);
      if (projects) projects.push(name);
      else projectsByMessage.set(error.message, [name]);
    }
    for (const [message, projects] of projectsByMessage) {
      lines.push({
        key: `${host.serverId}:${message}`,
        text: `${host.serverName} · ${projects.join(", ")}: ${message}`,
      });
    }
  }
  return lines;
}
