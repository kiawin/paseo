import type { Logger } from "pino";

import type { ForgeService, PullRequestSummary } from "../../services/forge-service.js";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentPromptSource } from "../agent/agent-messages/index.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AutomationTurnBudget } from "../pr-watch/turn-budget.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { PersistedProjectRecord, ProjectRegistry } from "../workspace-registry.js";
import { PR_REVIEW_AGENT_LABEL } from "./labels.js";
import { buildReReviewPrompt, buildReviewPrompt, type ReviewPromptInput } from "./prompt.js";
import { prReviewId, type PrReviewRecord, type PrReviewStore } from "./store.js";

/** Every request on your review queue: direct and through a team. Listed, never auto-reviewed. */
const REVIEW_REQUESTS_QUERY = "is:open review-requested:@me";
/** Only direct requests start a review on their own. */
const DIRECT_REVIEW_REQUESTS_QUERY = "is:open user-review-requested:@me";
export const PR_REVIEW_POLL_INTERVAL_MS = 3 * 60_000;
const REVIEW_REQUESTS_LIMIT = 50;

/** What started a review: a request (or a click), or a new commit in push mode. */
type ReviewTrigger = "request" | "push";

interface ReviewParams {
  project: PersistedProjectRecord;
  pullRequest: PullRequestSummary;
  provider: string | null;
  trigger?: ReviewTrigger;
}

export interface ReviewRequest {
  projectId: string;
  pullRequest: PullRequestSummary;
  review: PrReviewRecord | null;
}

export interface ReviewRequestListResult {
  requests: ReviewRequest[];
  errors: { projectId: string; message: string }[];
}

export interface CreateReviewerParams {
  /** The project's checkout. */
  cwd: string;
  prNumber: number;
  /** Cut a new worktree of the PR for the reviewer; false runs it in `cwd`. */
  checkout: boolean;
  provider: string;
  title: string;
  prompt: string;
  labels: Record<string, string>;
}

export interface CreatedReviewer {
  agentId: string;
  workspaceId: string | null;
  /** False when the first prompt couldn't start; the reviewer is idle. */
  promptStarted: boolean;
}

export interface PrReviewServiceOptions {
  store: PrReviewStore;
  projectRegistry: Pick<ProjectRegistry, "list" | "get">;
  workspaceGitService: Pick<WorkspaceGitService, "resolveForge">;
  agentManager: Pick<AgentManager, "subscribe" | "hasInFlightRun">;
  agentStorage: Pick<AgentStorage, "get">;
  createReviewer: (params: CreateReviewerParams) => Promise<CreatedReviewer>;
  /** Must never replace a running turn; a busy agent makes it reject. */
  sendPrompt: (params: {
    agentId: string;
    prompt: string;
    source: AgentPromptSource;
  }) => Promise<void>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  /** Shared with PR auto-fix. */
  turnBudget: AutomationTurnBudget;
  logger: Logger;
  now?: () => number;
  pollIntervalMs?: number;
}

/**
 * Lists the PRs waiting for your review, starts reviewer agents in their own
 * worktrees, reviews automatically for projects that turn it on, and archives
 * a review's worktree once its PR merges or closes. GitHub only.
 */
export class PrReviewService {
  private readonly options: PrReviewServiceOptions;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** Reviewer agents holding a turn-budget slot, by agent id. */
  private readonly budgetedReviewers = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private unsubscribeAgents: (() => void) | null = null;

  constructor(options: PrReviewServiceOptions) {
    this.options = options;
    this.logger = options.logger.child({ module: "pr-review" });
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.unsubscribeAgents = this.options.agentManager.subscribe((event) =>
      this.handleAgentEvent(event),
    );
    const interval = this.options.pollIntervalMs ?? PR_REVIEW_POLL_INTERVAL_MS;
    this.pollTimer = setInterval(() => void this.poll(), interval);
    void this.poll();
  }

  stop(): void {
    this.unsubscribeAgents?.();
    this.unsubscribeAgents = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const agentId of this.budgetedReviewers)
      this.options.turnBudget.release(budgetKey(agentId));
    this.budgetedReviewers.clear();
  }

  /** Resolves once an in-progress poll has finished. */
  async whenIdle(): Promise<void> {
    await this.polling;
  }

  async listReviewRequests(projectId?: string): Promise<ReviewRequestListResult> {
    const projects = await this.reviewableProjects(projectId);
    const result: ReviewRequestListResult = { requests: [], errors: [] };
    await Promise.all(
      projects.map(async (project) => {
        try {
          const forge = await this.githubForge(project);
          if (!forge) {
            if (projectId) {
              result.errors.push({
                projectId: project.projectId,
                message: "Review requests are only available for GitHub projects",
              });
            }
            return;
          }
          const pullRequests = await forge.listPullRequests({
            cwd: project.rootPath,
            query: REVIEW_REQUESTS_QUERY,
            limit: REVIEW_REQUESTS_LIMIT,
          });
          for (const pullRequest of pullRequests) {
            result.requests.push({
              projectId: project.projectId,
              pullRequest,
              review: await this.options.store.get(
                prReviewId(project.projectId, pullRequest.number),
              ),
            });
          }
        } catch (error) {
          result.errors.push({ projectId: project.projectId, message: describeError(error) });
        }
      }),
    );
    result.requests.sort((left, right) =>
      right.pullRequest.updatedAt.localeCompare(left.pullRequest.updatedAt),
    );
    return result;
  }

  /**
   * Reviews a PR in a new worktree, or asks the existing reviewer to look again.
   * The provider falls back to the project's reviewer setting.
   */
  async startReview(params: {
    projectId: string;
    prNumber: number;
    provider?: string;
  }): Promise<PrReviewRecord> {
    const project = await this.options.projectRegistry.get(params.projectId);
    if (!project || project.archivedAt) throw new Error("Project not found");
    const forge = await this.githubForge(project);
    if (!forge) throw new Error("Reviews are only available for GitHub projects");
    const pullRequest = await forge.getPullRequest({
      cwd: project.rootPath,
      number: params.prNumber,
      force: true,
      reason: "pr-review",
    });
    if (pullRequest.state.toLowerCase() !== "open") {
      throw new Error(`PR #${params.prNumber} is not open`);
    }
    const record = await this.review({
      project,
      pullRequest,
      provider: params.provider?.trim() || project.prAutomation?.reviewProvider || null,
    });
    return record;
  }

  /** One round: start automatic reviews, then archive reviews whose PR has ended. */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.runPoll()
      .catch((error: unknown) => this.logger.error({ err: error }, "pr-review.poll.failed"))
      .finally(() => {
        this.polling = null;
      });
    return this.polling;
  }

  private async runPoll(): Promise<void> {
    const stillRequested = new Set<string>();
    for (const project of await this.reviewableProjects()) {
      const settings = project.prAutomation;
      if (!settings?.autoReview || !settings.reviewProvider) continue;
      await this.autoReviewProject(project, settings.reviewProvider, stillRequested);
    }
    await this.settleReviews(stillRequested);
  }

  private async autoReviewProject(
    project: PersistedProjectRecord,
    provider: string,
    stillRequested: Set<string>,
  ): Promise<void> {
    let pullRequests: PullRequestSummary[];
    try {
      const forge = await this.githubForge(project);
      if (!forge) return;
      pullRequests = await forge.listPullRequests({
        cwd: project.rootPath,
        query: DIRECT_REVIEW_REQUESTS_QUERY,
        limit: REVIEW_REQUESTS_LIMIT,
        force: true,
        reason: "pr-review-poll",
      });
    } catch (error) {
      this.logger.warn({ err: error, projectId: project.projectId }, "pr-review.list.failed");
      // Keep every review of this project as it is; a failed read says nothing.
      for (const record of await this.options.store.list()) {
        if (record.projectId === project.projectId) stillRequested.add(record.id);
      }
      return;
    }
    // Mark every request first: a full budget below must not make a later
    // request look withdrawn, or it would be reviewed twice.
    for (const pullRequest of pullRequests) {
      stillRequested.add(prReviewId(project.projectId, pullRequest.number));
    }
    for (const pullRequest of pullRequests) {
      const id = prReviewId(project.projectId, pullRequest.number);
      const existing = await this.options.store.get(id);
      if (existing?.requestActive && existing.state === "active") continue;
      // Fork PRs and drafts are listed for you to review by hand.
      if (pullRequest.isCrossRepository !== false || pullRequest.isDraft) continue;
      const slot = `pr-review:${id}`;
      if (!this.options.turnBudget.tryAcquire(slot)) return;
      try {
        const record = await this.review({ project, pullRequest, provider });
        this.holdSlotUntilIdle(slot, record.agentId);
      } catch (error) {
        this.options.turnBudget.release(slot);
        this.logger.warn(
          { err: error, projectId: project.projectId, prNumber: pullRequest.number },
          "pr-review.auto-review.failed",
        );
      }
    }
  }

  /**
   * Clears requests that left the queue, archives reviews whose PR merged or
   * closed, and, for projects that re-review on push, prompts the reviewer when
   * the PR's head moved past the commit it reviewed.
   */
  private async settleReviews(stillRequested: Set<string>): Promise<void> {
    for (const record of await this.options.store.list()) {
      if (record.state !== "active") continue;
      const requested = stillRequested.has(record.id);
      if (!requested && record.requestActive) {
        await this.options.store.update(record.id, (current) => ({
          ...current,
          requestActive: false,
          updatedAt: this.timestamp(),
        }));
      }
      if (this.options.agentManager.hasInFlightRun(record.agentId)) continue;
      const project = await this.options.projectRegistry.get(record.projectId);
      const reReviewOnPush = project?.prAutomation?.reReviewOn === "push";
      // A PR still in your review queue is open; only push mode needs its head.
      if (requested && !reReviewOnPush) continue;
      await this.followUp(record, project, reReviewOnPush);
    }
  }

  private async followUp(
    record: PrReviewRecord,
    project: PersistedProjectRecord | null,
    reReviewOnPush: boolean,
  ): Promise<void> {
    try {
      const forge = project && !project.archivedAt ? await this.githubForge(project) : null;
      if (!project || !forge) return;
      const pullRequest = await forge.getPullRequest({
        cwd: project.rootPath,
        number: record.prNumber,
        force: true,
        reason: "pr-review-follow-up",
      });
      if (pullRequest.state.toLowerCase() !== "open") {
        await this.archive(record);
      } else if (reReviewOnPush) {
        await this.reReviewNewHead(record, project, pullRequest);
      }
    } catch (error) {
      this.logger.warn({ err: error, reviewId: record.id }, "pr-review.follow-up.failed");
    }
  }

  private async archive(record: PrReviewRecord): Promise<void> {
    if (record.ownsWorktree && record.workspaceId) {
      await this.options.archiveWorkspace(record.workspaceId);
    }
    await this.options.store.update(record.id, (current) => ({
      ...current,
      state: "archived",
      requestActive: false,
      updatedAt: this.timestamp(),
    }));
  }

  private async reReviewNewHead(
    record: PrReviewRecord,
    project: PersistedProjectRecord,
    pullRequest: PullRequestSummary,
  ): Promise<void> {
    const headSha = pullRequest.headSha ?? null;
    // No review went out yet, or nothing new: the request path handles the first.
    if (!headSha || !record.reviewedHeadSha || headSha === record.reviewedHeadSha) return;
    // A reviewer you archived stays archived; a push doesn't bring it back.
    const reviewer = await this.options.agentStorage.get(record.agentId);
    if (!reviewer || reviewer.archivedAt) return;
    const slot = `pr-review:${record.id}`;
    if (!this.options.turnBudget.tryAcquire(slot)) return;
    try {
      const updated = await this.review({ project, pullRequest, provider: null, trigger: "push" });
      this.holdSlotUntilIdle(slot, updated.agentId);
    } catch (error) {
      this.options.turnBudget.release(slot);
      this.logger.warn({ err: error, reviewId: record.id }, "pr-review.re-review.failed");
    }
  }

  /** One review at a time per PR, so a poll and a click can't both create a reviewer. */
  private review(params: ReviewParams): Promise<PrReviewRecord> {
    const id = prReviewId(params.project.projectId, params.pullRequest.number);
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.reviewLocked(params));
    this.locks.set(id, next);
    void next
      .catch(() => undefined)
      .then(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
        return undefined;
      });
    return next;
  }

  private async reviewLocked(params: ReviewParams): Promise<PrReviewRecord> {
    const { project, pullRequest } = params;
    const id = prReviewId(project.projectId, pullRequest.number);
    const promptInput = toReviewPromptInput(project, pullRequest);

    const existing = await this.options.store.get(id);
    const reviewer = existing ? await this.options.agentStorage.get(existing.agentId) : null;
    if (existing && existing.state === "active" && reviewer && !reviewer.archivedAt) {
      return this.promptReviewer(existing, promptInput, params.trigger ?? "request");
    }

    if (!params.provider) {
      throw new Error("Choose a reviewer provider in the project's settings first");
    }
    const created = await this.options.createReviewer({
      cwd: project.rootPath,
      prNumber: pullRequest.number,
      checkout: !promptInput.isCrossRepository,
      provider: params.provider,
      title: `Review PR #${pullRequest.number}: ${pullRequest.title}`,
      prompt: buildReviewPrompt(promptInput),
      labels: { [PR_REVIEW_AGENT_LABEL]: pullRequest.url },
    });
    const timestamp = this.timestamp();
    const record: PrReviewRecord = {
      id,
      projectId: project.projectId,
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
      agentId: created.agentId,
      workspaceId: created.workspaceId,
      ownsWorktree: !promptInput.isCrossRepository,
      // An idle reviewer whose prompt never started stays retryable: the next
      // poll, or the next Review click, sends it the review prompt.
      reviewedHeadSha: created.promptStarted ? (pullRequest.headSha ?? null) : null,
      requestActive: created.promptStarted,
      state: "active",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.options.store.upsert(record);
    if (!created.promptStarted) {
      throw new Error("The reviewer was created, but its first prompt didn't start. Try again.");
    }
    return record;
  }

  /** Asks a reviewer that already exists to review, or to review again. */
  private async promptReviewer(
    existing: PrReviewRecord,
    promptInput: ReviewPromptInput,
    trigger: ReviewTrigger,
  ): Promise<PrReviewRecord> {
    // Already reviewing this request at this head: nothing new to ask.
    if (existing.requestActive && existing.reviewedHeadSha === promptInput.headSha) {
      return existing;
    }
    await this.options.sendPrompt({
      agentId: existing.agentId,
      prompt: existing.reviewedHeadSha
        ? buildReReviewPrompt({ ...promptInput, previousHeadSha: existing.reviewedHeadSha })
        : buildReviewPrompt(promptInput),
      source: {
        kind: "forge-event",
        agentId: `pr-review:${existing.id}`,
        title: `PR #${existing.prNumber} review`,
      },
    });
    const updated = await this.options.store.update(existing.id, (current) => ({
      ...current,
      reviewedHeadSha: promptInput.headSha,
      // A push doesn't put the PR back in your review queue.
      requestActive: trigger === "request" ? true : current.requestActive,
      updatedAt: this.timestamp(),
    }));
    return updated ?? existing;
  }

  /** Keeps the review's slot until its reviewer goes idle. */
  private holdSlotUntilIdle(slot: string, agentId: string): void {
    if (!this.options.agentManager.hasInFlightRun(agentId)) {
      this.options.turnBudget.release(slot);
      return;
    }
    this.options.turnBudget.transfer(slot, budgetKey(agentId));
    this.budgetedReviewers.add(agentId);
  }

  private handleAgentEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_state") return;
    const agentId = event.agent.id;
    if (!this.budgetedReviewers.has(agentId)) return;
    if (this.options.agentManager.hasInFlightRun(agentId)) return;
    this.budgetedReviewers.delete(agentId);
    this.options.turnBudget.release(budgetKey(agentId));
  }

  private async reviewableProjects(projectId?: string): Promise<PersistedProjectRecord[]> {
    const projects = projectId
      ? [await this.options.projectRegistry.get(projectId)].filter(
          (project): project is PersistedProjectRecord => project !== null,
        )
      : await this.options.projectRegistry.list();
    return projects.filter((project) => !project.archivedAt && project.kind === "git");
  }

  private async githubForge(project: PersistedProjectRecord): Promise<ForgeService | null> {
    const resolution = await this.options.workspaceGitService.resolveForge(project.rootPath);
    return resolution?.forge === "github" ? resolution.service : null;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function toReviewPromptInput(
  project: PersistedProjectRecord,
  pullRequest: PullRequestSummary,
): ReviewPromptInput {
  return {
    prNumber: pullRequest.number,
    prUrl: pullRequest.url,
    title: pullRequest.title,
    author: pullRequest.author ?? null,
    baseRefName: pullRequest.baseRefName,
    headSha: pullRequest.headSha ?? null,
    // Unknown counts as a fork: only a confirmed same-repo PR gets checked out.
    isCrossRepository: pullRequest.isCrossRepository !== false,
    postReviews: project.prAutomation?.postReviews ?? false,
  };
}

function budgetKey(agentId: string): string {
  return `pr-review-agent:${agentId}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
