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
  /** The project's checkout; the reviewer gets a new worktree of the PR cut from it. */
  cwd: string;
  prNumber: number;
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
    for (const pullRequest of pullRequests) {
      const id = prReviewId(project.projectId, pullRequest.number);
      stillRequested.add(id);
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

  /** Clears requests that left the queue, and archives reviews whose PR merged or closed. */
  private async settleReviews(stillRequested: Set<string>): Promise<void> {
    for (const record of await this.options.store.list()) {
      if (record.state !== "active" || stillRequested.has(record.id)) continue;
      if (record.requestActive) {
        await this.options.store.update(record.id, (current) => ({
          ...current,
          requestActive: false,
          updatedAt: this.timestamp(),
        }));
      }
      if (this.options.agentManager.hasInFlightRun(record.agentId)) continue;
      await this.archiveIfEnded(record);
    }
  }

  private async archiveIfEnded(record: PrReviewRecord): Promise<void> {
    try {
      const project = await this.options.projectRegistry.get(record.projectId);
      const forge = project ? await this.githubForge(project) : null;
      if (!project || !forge) return;
      const pullRequest = await forge.getPullRequest({
        cwd: project.rootPath,
        number: record.prNumber,
        force: true,
        reason: "pr-review-archive",
      });
      if (pullRequest.state.toLowerCase() === "open") return;
      if (record.workspaceId) await this.options.archiveWorkspace(record.workspaceId);
      await this.options.store.update(record.id, (current) => ({
        ...current,
        state: "archived",
        requestActive: false,
        updatedAt: this.timestamp(),
      }));
    } catch (error) {
      this.logger.warn({ err: error, reviewId: record.id }, "pr-review.archive.failed");
    }
  }

  private async review(params: {
    project: PersistedProjectRecord;
    pullRequest: PullRequestSummary;
    provider: string | null;
  }): Promise<PrReviewRecord> {
    const { project, pullRequest } = params;
    const id = prReviewId(project.projectId, pullRequest.number);
    const promptInput: ReviewPromptInput = {
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
      title: pullRequest.title,
      author: pullRequest.author ?? null,
      baseRefName: pullRequest.baseRefName,
      headSha: pullRequest.headSha ?? null,
      isCrossRepository: pullRequest.isCrossRepository !== false,
      postReviews: project.prAutomation?.postReviews ?? false,
    };

    const existing = await this.options.store.get(id);
    const reviewer = existing ? await this.options.agentStorage.get(existing.agentId) : null;
    if (existing && existing.state === "active" && reviewer && !reviewer.archivedAt) {
      await this.options.sendPrompt({
        agentId: existing.agentId,
        prompt: buildReReviewPrompt({ ...promptInput, previousHeadSha: existing.reviewedHeadSha }),
        source: {
          kind: "forge-event",
          agentId: `pr-review:${id}`,
          title: `PR #${pullRequest.number} review`,
        },
      });
      const updated = await this.options.store.update(id, (current) => ({
        ...current,
        reviewedHeadSha: pullRequest.headSha ?? null,
        requestActive: true,
        updatedAt: this.timestamp(),
      }));
      return updated ?? existing;
    }

    if (!params.provider) {
      throw new Error("Choose a reviewer provider in the project's settings first");
    }
    const created = await this.options.createReviewer({
      cwd: project.rootPath,
      prNumber: pullRequest.number,
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
      reviewedHeadSha: pullRequest.headSha ?? null,
      requestActive: true,
      state: "active",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.options.store.upsert(record);
    return record;
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

function budgetKey(agentId: string): string {
  return `pr-review-agent:${agentId}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
