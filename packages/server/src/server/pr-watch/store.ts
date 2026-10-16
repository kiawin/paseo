import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { FileBackedRegistry } from "../file-backed-registry.js";

/** Failure keys kept per watch; older keys belong to heads the PR has moved past. */
export const PR_WATCH_MAX_SEEN_FAILURE_KEYS = 200;

const PrWatchStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active") }),
  z.object({
    kind: z.literal("paused"),
    reason: z.enum(["attempt_limit", "untrusted_workspace"]),
    at: z.string(),
  }),
  z.object({
    kind: z.literal("stopped"),
    reason: z.enum(["merged", "closed", "agent_archived", "user_disabled"]),
    at: z.string(),
  }),
]);

const PrWatchCiStateSchema = z.object({
  /** Head commit the counters below refer to. */
  headSha: z.string().nullable(),
  /** Failures already sent to the agent, so a restart or re-poll doesn't resend them. */
  seenFailureKeys: z.array(z.string()),
  /** Auto-fix prompts sent for headSha, for any reason: CI, review comments or conflicts. */
  attemptsForHead: z.number().int().nonnegative(),
  /**
   * Heads in a row that still failed after a fix attempt. Each fix push makes a
   * new head, so the per-head cap alone cannot stop a fix loop.
   */
  consecutiveFailedHeads: z.number().int().nonnegative(),
});

const PrWatchReviewStateSchema = z.object({
  /** Review comments written before this time predate the watch and are ignored. */
  since: z.string(),
  /** PR `updatedAt` the timeline was last read at; a new value means new activity. */
  lastUpdatedAt: z.string().nullable(),
  /** Comments already sent to the agent. */
  seenCommentIds: z.array(z.string()),
});

const PrWatchConflictStateSchema = z.object({
  /** Head the agent was last told conflicts with the base branch; one notice per head. */
  notifiedHeadSha: z.string().nullable(),
});

export const PrWatchRecordSchema = z.object({
  agentId: z.string(),
  cwd: z.string(),
  forge: z.string(),
  headRef: z.string(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  state: PrWatchStateSchema,
  ci: PrWatchCiStateSchema,
  review: PrWatchReviewStateSchema,
  conflict: PrWatchConflictStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PrWatchRecord = z.infer<typeof PrWatchRecordSchema>;
export type PrWatchState = z.infer<typeof PrWatchStateSchema>;

export function createInitialPrWatchCiState(): PrWatchRecord["ci"] {
  return { headSha: null, seenFailureKeys: [], attemptsForHead: 0, consecutiveFailedHeads: 0 };
}

export function createInitialPrWatchReviewState(since: string): PrWatchRecord["review"] {
  return { since, lastUpdatedAt: null, seenCommentIds: [] };
}

export const PR_WATCH_MAX_SEEN_COMMENT_IDS = 500;

/** One watch per agent: the agent Paseo wakes when its PR's CI fails. */
export class PrWatchStore extends FileBackedRegistry<PrWatchRecord> {
  constructor(paseoHome: string, logger: Logger) {
    super({
      filePath: path.join(paseoHome, "pr-watches.json"),
      logger,
      schema: PrWatchRecordSchema,
      getId: (record) => record.agentId,
      component: "pr-watch-store",
      module: "pr-watch",
    });
  }

  async listActive(): Promise<PrWatchRecord[]> {
    return (await this.list()).filter((record) => record.state.kind === "active");
  }
}
