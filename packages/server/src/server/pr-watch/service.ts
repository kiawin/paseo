import type { Logger } from "pino";

import type { CheckDetails } from "../../services/forge-service.js";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentPromptSource } from "../agent/agent-messages/index.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
  WorkspaceGitSubscription,
} from "../workspace-git-service.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { observePullRequest, type PrWatchCiFailure, type PrWatchPullRequest } from "./detect.js";
import { buildCiFailurePrompt } from "./prompt.js";
import {
  createInitialPrWatchCiState,
  PR_WATCH_MAX_SEEN_FAILURE_KEYS,
  type PrWatchRecord,
  type PrWatchState,
  type PrWatchStore,
} from "./store.js";

export const PR_WATCH_MAX_CONCURRENT_TURNS = 3;
export const PR_WATCH_MAX_ATTEMPTS_PER_HEAD = 3;
export const PR_WATCH_MAX_CONSECUTIVE_FAILED_HEADS = 3;
/** How long to wait for a head's other checks to finish after its first failure. */
export const PR_WATCH_SETTLE_TIMEOUT_MS = 10 * 60_000;

export interface PrWatchSendPromptParams {
  agentId: string;
  prompt: string;
  source: AgentPromptSource;
}

export interface PrWatchServiceOptions {
  store: PrWatchStore;
  workspaceGitService: Pick<
    WorkspaceGitService,
    "registerWorkspace" | "getSnapshot" | "resolveForge"
  >;
  agentManager: Pick<AgentManager, "subscribe" | "hasInFlightRun" | "getAgent">;
  agentStorage: Pick<AgentStorage, "get">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  /** Must never replace a running turn; a busy agent makes it reject. */
  sendPrompt: (params: PrWatchSendPromptParams) => Promise<void>;
  onWatchPaused?: (record: PrWatchRecord) => void;
  logger: Logger;
  now?: () => number;
  maxConcurrentTurns?: number;
  maxAttemptsPerHead?: number;
  maxConsecutiveFailedHeads?: number;
  settleTimeoutMs?: number;
}

/** What a watch holds in memory between polls; rebuilt from the next poll after a restart. */
interface WatchRuntime {
  pending: Map<string, PrWatchCiFailure>;
  pendingHeadSha: string | null;
  /** Repo identity from the last poll; GitHub addresses check runs by owner and name. */
  repo: { owner?: string; name?: string };
  firstFailureAt: number | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
  turnInFlight: boolean;
}

interface CwdSubscription {
  subscription: WorkspaceGitSubscription;
  agentIds: Set<string>;
}

/**
 * Wakes an agent when CI fails on the PR for its branch. Polling stays alive
 * without a connected client because the service holds its own workspace
 * registration for every watched folder.
 */
export class PrWatchService {
  private readonly options: PrWatchServiceOptions;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly maxConcurrentTurns: number;
  private readonly maxAttemptsPerHead: number;
  private readonly maxConsecutiveFailedHeads: number;
  private readonly settleTimeoutMs: number;
  private readonly runtimes = new Map<string, WatchRuntime>();
  private readonly cwdSubscriptions = new Map<string, CwdSubscription>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly readyQueue: string[] = [];
  private readonly activeTurns = new Set<string>();
  /** Agents whose send was refused; retried on their next state change, not in a loop. */
  private readonly deferred = new Set<string>();
  private unsubscribeAgents: (() => void) | null = null;

  constructor(options: PrWatchServiceOptions) {
    this.options = options;
    this.logger = options.logger.child({ module: "pr-watch" });
    this.now = options.now ?? Date.now;
    this.maxConcurrentTurns = options.maxConcurrentTurns ?? PR_WATCH_MAX_CONCURRENT_TURNS;
    this.maxAttemptsPerHead = options.maxAttemptsPerHead ?? PR_WATCH_MAX_ATTEMPTS_PER_HEAD;
    this.maxConsecutiveFailedHeads =
      options.maxConsecutiveFailedHeads ?? PR_WATCH_MAX_CONSECUTIVE_FAILED_HEADS;
    this.settleTimeoutMs = options.settleTimeoutMs ?? PR_WATCH_SETTLE_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    this.unsubscribeAgents = this.options.agentManager.subscribe((event) =>
      this.handleAgentEvent(event),
    );
    for (const record of await this.options.store.listActive()) {
      const agent = await this.options.agentStorage.get(record.agentId);
      if (!agent) {
        await this.options.store.remove(record.agentId);
      } else if (agent.archivedAt) {
        await this.setState(record.agentId, { kind: "stopped", reason: "agent_archived" });
      } else {
        this.watchCwd(record.cwd, record.agentId);
      }
    }
  }

  stop(): void {
    this.unsubscribeAgents?.();
    this.unsubscribeAgents = null;
    for (const { subscription } of this.cwdSubscriptions.values()) subscription.unsubscribe();
    this.cwdSubscriptions.clear();
    for (const runtime of this.runtimes.values()) {
      if (runtime.settleTimer) clearTimeout(runtime.settleTimer);
    }
    this.runtimes.clear();
    this.readyQueue.length = 0;
    this.activeTurns.clear();
    this.deferred.clear();
  }

  /** Resolves once queued work for every watch has finished. */
  async whenIdle(): Promise<void> {
    while (this.locks.size > 0) {
      await Promise.all(this.locks.values());
    }
  }

  list(): Promise<PrWatchRecord[]> {
    return this.options.store.list();
  }

  /** Turns auto-fix on for the agent's current PR, or off. Turning it on resets the counters. */
  async setWatch(params: { agentId: string; enabled: boolean }): Promise<PrWatchRecord | null> {
    if (!params.enabled) {
      await this.stopForAgent(params.agentId, "user_disabled");
      return this.options.store.get(params.agentId);
    }
    const agent = await this.options.agentStorage.get(params.agentId);
    if (!agent || agent.archivedAt) {
      throw new Error(`Agent ${params.agentId} not found or archived`);
    }
    const snapshot = await this.options.workspaceGitService.getSnapshot(agent.cwd, {
      force: true,
      reason: "pr-watch",
    });
    const pullRequest = snapshot.forge.pullRequest;
    if (!pullRequest || pullRequest.isMerged || pullRequest.state !== "open") {
      throw new Error("The agent's branch has no open pull request to watch");
    }
    const forge =
      snapshot.forge.forge ??
      (await this.options.workspaceGitService.resolveForge(agent.cwd))?.forge;
    if (forge !== "github" && forge !== "gitlab") {
      throw new Error(
        `Auto-fix supports GitHub and GitLab pull requests, not ${forge ?? "this forge"}`,
      );
    }
    const timestamp = new Date(this.now()).toISOString();
    const existing = await this.options.store.get(params.agentId);
    const record: PrWatchRecord = {
      agentId: params.agentId,
      cwd: agent.cwd,
      forge,
      headRef: pullRequest.headRefName,
      prNumber: pullRequest.number ?? null,
      prUrl: pullRequest.url,
      state: { kind: "active" },
      ci: { ...createInitialPrWatchCiState(), headSha: pullRequest.headSha ?? null },
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (existing && existing.cwd !== record.cwd) this.unwatchCwd(existing.cwd, params.agentId);
    this.clearRuntime(params.agentId);
    await this.options.store.upsert(record);
    this.watchCwd(record.cwd, record.agentId);
    await this.withLock(record.agentId, () => this.evaluate(record.agentId, pullRequest));
    return this.options.store.get(params.agentId);
  }

  async stopForAgent(
    agentId: string,
    reason: Extract<PrWatchState, { kind: "stopped" }>["reason"],
  ): Promise<void> {
    await this.withLock(agentId, async () => {
      if (!(await this.options.store.get(agentId))) return;
      await this.setState(agentId, { kind: "stopped", reason });
    });
  }

  private watchCwd(cwd: string, agentId: string): void {
    const existing = this.cwdSubscriptions.get(cwd);
    if (existing) {
      existing.agentIds.add(agentId);
      return;
    }
    const agentIds = new Set([agentId]);
    const subscription = this.options.workspaceGitService.registerWorkspace({ cwd }, (snapshot) =>
      this.handleSnapshot(snapshot, agentIds),
    );
    this.cwdSubscriptions.set(cwd, { subscription, agentIds });
  }

  private unwatchCwd(cwd: string, agentId: string): void {
    const entry = this.cwdSubscriptions.get(cwd);
    if (!entry) return;
    entry.agentIds.delete(agentId);
    if (entry.agentIds.size === 0) {
      entry.subscription.unsubscribe();
      this.cwdSubscriptions.delete(cwd);
    }
  }

  private handleSnapshot(snapshot: WorkspaceGitRuntimeSnapshot, agentIds: Set<string>): void {
    for (const agentId of agentIds) {
      void this.withLock(agentId, () => this.evaluate(agentId, snapshot.forge.pullRequest));
    }
  }

  private async evaluate(agentId: string, pullRequest: PrWatchPullRequest | null): Promise<void> {
    const record = await this.options.store.get(agentId);
    if (!record || record.state.kind !== "active") return;
    const observation = observePullRequest(record, pullRequest);
    if (observation.kind === "not_watched_pull_request") return;
    if (observation.kind === "ended") {
      await this.setState(agentId, { kind: "stopped", reason: observation.reason });
      return;
    }

    const runtime = this.runtime(agentId);
    if (observation.headChanged || record.ci.headSha === null) {
      this.resetPending(runtime);
      await this.startHead(agentId, observation.headSha);
    }
    if (observation.checksSettled && isGreen(pullRequest) && record.ci.consecutiveFailedHeads > 0) {
      await this.options.store.update(agentId, (current) => ({
        ...current,
        ci: { ...current.ci, consecutiveFailedHeads: 0 },
      }));
    }

    for (const failure of observation.newFailures) runtime.pending.set(failure.key, failure);
    if (runtime.pending.size === 0) return;
    runtime.pendingHeadSha = observation.headSha;
    runtime.repo = { owner: pullRequest?.repoOwner, name: pullRequest?.repoName };
    runtime.firstFailureAt ??= this.now();

    const waited = this.now() - runtime.firstFailureAt;
    if (observation.checksSettled || waited >= this.settleTimeoutMs) {
      this.markReady(agentId);
    } else if (!runtime.settleTimer) {
      runtime.settleTimer = setTimeout(() => {
        runtime.settleTimer = null;
        this.markReady(agentId);
      }, this.settleTimeoutMs - waited);
    }
  }

  /** A new head starts fresh: no failures seen and no attempts made on it yet. */
  private async startHead(agentId: string, headSha: string | null): Promise<void> {
    await this.options.store.update(agentId, (current) => ({
      ...current,
      ci: { ...current.ci, headSha, seenFailureKeys: [], attemptsForHead: 0 },
      updatedAt: new Date(this.now()).toISOString(),
    }));
  }

  private markReady(agentId: string): void {
    const runtime = this.runtimes.get(agentId);
    if (!runtime || runtime.pending.size === 0 || runtime.turnInFlight) return;
    if (!this.readyQueue.includes(agentId)) this.readyQueue.push(agentId);
    this.pump();
  }

  /** Starts queued sends, oldest first, while slots are free and their agents are idle. */
  private pump(): void {
    // Iterate a copy: dispatching removes the agent from the queue.
    for (const agentId of this.readyQueue.slice()) {
      if (this.activeTurns.size >= this.maxConcurrentTurns) return;
      if (this.options.agentManager.hasInFlightRun(agentId)) continue;
      this.readyQueue.splice(this.readyQueue.indexOf(agentId), 1);
      this.activeTurns.add(agentId);
      void this.withLock(agentId, () => this.dispatch(agentId));
    }
  }

  private async dispatch(agentId: string): Promise<void> {
    const runtime = this.runtimes.get(agentId);
    const record = await this.options.store.get(agentId);
    if (!runtime || !record || record.state.kind !== "active" || runtime.pending.size === 0) {
      this.releaseTurn(agentId);
      return;
    }
    const blocked = await this.blockReason(record);
    if (blocked) {
      this.releaseTurn(agentId);
      if (blocked.kind === "remove") await this.removeWatch(record);
      else await this.setState(agentId, blocked.state);
      return;
    }

    const failures = [...runtime.pending.values()];
    runtime.pending.clear();
    if (runtime.settleTimer) clearTimeout(runtime.settleTimer);
    runtime.settleTimer = null;
    runtime.firstFailureAt = null;
    const isFirstAttemptOnHead = record.ci.attemptsForHead === 0;
    const prompt = buildCiFailurePrompt({
      prNumber: record.prNumber,
      prUrl: record.prUrl,
      headSha: runtime.pendingHeadSha,
      attempt: record.ci.attemptsForHead + 1,
      maxAttempts: this.maxAttemptsPerHead,
      failures: await Promise.all(
        failures.map(async (failure) => ({
          failure,
          details: await this.fetchCheckDetails(record, runtime, failure),
        })),
      ),
    });

    runtime.turnInFlight = true;
    try {
      await this.options.sendPrompt({
        agentId,
        prompt,
        source: {
          kind: "forge-event",
          agentId: `pr-watch:${agentId}`,
          title: record.prNumber !== null ? `PR #${record.prNumber} auto-fix` : "PR auto-fix",
        },
      });
    } catch (error) {
      // Busy, or the agent couldn't load: keep the failures for the next idle moment.
      runtime.turnInFlight = false;
      for (const failure of failures) runtime.pending.set(failure.key, failure);
      this.releaseTurn(agentId);
      this.deferred.add(agentId);
      this.logger.info({ err: error, agentId }, "pr-watch.dispatch.deferred");
      return;
    }

    await this.options.store.update(agentId, (current) => ({
      ...current,
      ci: {
        ...current.ci,
        seenFailureKeys: [
          ...current.ci.seenFailureKeys,
          ...failures.map((failure) => failure.key),
        ].slice(-PR_WATCH_MAX_SEEN_FAILURE_KEYS),
        attemptsForHead: current.ci.attemptsForHead + 1,
        consecutiveFailedHeads: current.ci.consecutiveFailedHeads + (isFirstAttemptOnHead ? 1 : 0),
      },
      updatedAt: new Date(this.now()).toISOString(),
    }));
  }

  private async blockReason(
    record: PrWatchRecord,
  ): Promise<{ kind: "remove" } | { kind: "state"; state: StateChange } | null> {
    const agent = await this.options.agentStorage.get(record.agentId);
    if (!agent) return { kind: "remove" };
    if (agent.archivedAt) {
      return { kind: "state", state: { kind: "stopped", reason: "agent_archived" } };
    }
    const workspace = agent.workspaceId
      ? await this.options.workspaceRegistry.get(agent.workspaceId)
      : null;
    if (workspace?.untrustedSource) {
      return { kind: "state", state: { kind: "paused", reason: "untrusted_workspace" } };
    }
    const overHeadLimit = record.ci.attemptsForHead >= this.maxAttemptsPerHead;
    const overLoopLimit =
      record.ci.attemptsForHead === 0 &&
      record.ci.consecutiveFailedHeads >= this.maxConsecutiveFailedHeads;
    if (overHeadLimit || overLoopLimit) {
      return { kind: "state", state: { kind: "paused", reason: "attempt_limit" } };
    }
    return null;
  }

  private async fetchCheckDetails(
    record: PrWatchRecord,
    runtime: WatchRuntime,
    failure: PrWatchCiFailure,
  ): Promise<CheckDetails | null> {
    const { checkRunId, workflowRunId } = failure.check;
    if (checkRunId === undefined && workflowRunId === undefined) return null;
    try {
      const resolution = await this.options.workspaceGitService.resolveForge(record.cwd);
      if (!resolution) return null;
      return await resolution.service.getCheckDetails({
        cwd: record.cwd,
        ...(runtime.repo.owner ? { repoOwner: runtime.repo.owner } : {}),
        ...(runtime.repo.name ? { repoName: runtime.repo.name } : {}),
        ...(record.prNumber !== null ? { changeRequestNumber: record.prNumber } : {}),
        ...(checkRunId !== undefined ? { checkRunId } : {}),
        ...(workflowRunId !== undefined ? { workflowRunId } : {}),
      });
    } catch (error) {
      this.logger.warn({ err: error, agentId: record.agentId }, "pr-watch.check-details.failed");
      return null;
    }
  }

  private handleAgentEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_state") return;
    const agentId = event.agent.id;
    if (this.activeTurns.has(agentId) && !this.options.agentManager.hasInFlightRun(agentId)) {
      const runtime = this.runtimes.get(agentId);
      if (runtime) runtime.turnInFlight = false;
      this.releaseTurn(agentId);
      if (runtime && runtime.pending.size > 0) this.markReady(agentId);
    }
    if (this.deferred.delete(agentId)) this.markReady(agentId);
    if (this.readyQueue.length > 0) this.pump();
  }

  private releaseTurn(agentId: string): void {
    this.activeTurns.delete(agentId);
  }

  private async setState(agentId: string, state: StateChange): Promise<void> {
    const at = new Date(this.now()).toISOString();
    const next: PrWatchState = state.kind === "active" ? state : { ...state, at };
    const record = await this.options.store.update(agentId, (current) => ({
      ...current,
      state: next,
      updatedAt: at,
    }));
    if (!record) return;
    this.clearRuntime(agentId);
    this.unwatchCwd(record.cwd, agentId);
    if (next.kind === "paused") this.options.onWatchPaused?.(record);
  }

  private async removeWatch(record: PrWatchRecord): Promise<void> {
    this.clearRuntime(record.agentId);
    this.unwatchCwd(record.cwd, record.agentId);
    await this.options.store.remove(record.agentId);
  }

  private runtime(agentId: string): WatchRuntime {
    let runtime = this.runtimes.get(agentId);
    if (!runtime) {
      runtime = {
        pending: new Map(),
        pendingHeadSha: null,
        repo: {},
        firstFailureAt: null,
        settleTimer: null,
        turnInFlight: false,
      };
      this.runtimes.set(agentId, runtime);
    }
    return runtime;
  }

  private resetPending(runtime: WatchRuntime): void {
    runtime.pending.clear();
    runtime.firstFailureAt = null;
    if (runtime.settleTimer) clearTimeout(runtime.settleTimer);
    runtime.settleTimer = null;
  }

  private clearRuntime(agentId: string): void {
    const runtime = this.runtimes.get(agentId);
    if (runtime) this.resetPending(runtime);
    this.runtimes.delete(agentId);
    const queued = this.readyQueue.indexOf(agentId);
    if (queued !== -1) this.readyQueue.splice(queued, 1);
    this.deferred.delete(agentId);
  }

  /** Runs work for one watch at a time, so snapshot, dispatch and state changes never interleave. */
  private withLock(agentId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((error: unknown) => this.logger.error({ err: error, agentId }, "pr-watch.failed"));
    this.locks.set(agentId, next);
    void next.then(() => {
      if (this.locks.get(agentId) === next) this.locks.delete(agentId);
      return undefined;
    });
    return next;
  }
}

function isGreen(pullRequest: PrWatchPullRequest | null): boolean {
  const checks = pullRequest?.checks ?? [];
  return checks.length > 0 && checks.every((check) => check.status !== "failure");
}

type StateChange =
  | { kind: "active" }
  | Omit<Extract<PrWatchState, { kind: "paused" }>, "at">
  | Omit<Extract<PrWatchState, { kind: "stopped" }>, "at">;
