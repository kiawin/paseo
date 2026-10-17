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

/** One pull request someone asked you to review. */
export interface ReviewRequestRow {
  key: string;
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string | null;
  number: number;
  title: string;
  url: string;
  author: string | null;
  isDraft: boolean;
  isFork: boolean;
  updatedAt: string;
  action: ReviewRequestAction;
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

/** Every review request across the given hosts, most recently updated first. */
export function collectReviewRequestRows(
  hosts: readonly ReviewRequestSourceHost[],
): ReviewRequestRow[] {
  const rows: ReviewRequestRow[] = [];
  for (const host of hosts) {
    for (const request of host.reviewRequests) {
      rows.push({
        key: `${host.serverId}:${request.projectId}:${request.number}`,
        serverId: host.serverId,
        serverName: host.serverName,
        projectId: request.projectId,
        projectName: host.projectNames.get(request.projectId) ?? null,
        number: request.number,
        title: request.title,
        url: request.url,
        author: request.author,
        isDraft: request.isDraft,
        isFork: request.isCrossRepository,
        updatedAt: request.updatedAt,
        action: resolveReviewAction(request.review),
      });
    }
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

/** `#12 · author · project`, with the host appended when more than one is connected. */
export function buildReviewRequestMeta(row: ReviewRequestRow, showHostLabel: boolean): string {
  const parts = [`#${row.number}`];
  if (row.author) parts.push(row.author);
  if (row.projectName) parts.push(row.projectName);
  if (showHostLabel) parts.push(row.serverName);
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
