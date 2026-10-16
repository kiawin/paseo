import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { FileBackedRegistry } from "../file-backed-registry.js";

export const PrReviewRecordSchema = z.object({
  /** `${projectId}:${prNumber}` */
  id: z.string(),
  projectId: z.string(),
  prNumber: z.number().int().positive(),
  prUrl: z.string(),
  /** The reviewer agent; a re-review prompts it again while it isn't archived. */
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  /** Head commit the latest review covered. */
  reviewedHeadSha: z.string().nullable(),
  /**
   * True while the PR sits in your review requests. Submitting a review clears
   * the request; a re-request brings it back, and that starts a new review.
   */
  requestActive: z.boolean(),
  /** Archived once the PR merges or closes and its worktree is archived. */
  state: z.enum(["active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PrReviewRecord = z.infer<typeof PrReviewRecordSchema>;

export function prReviewId(projectId: string, prNumber: number): string {
  return `${projectId}:${prNumber}`;
}

/** Reviews Paseo started, one per project and PR. */
export class PrReviewStore extends FileBackedRegistry<PrReviewRecord> {
  constructor(paseoHome: string, logger: Logger) {
    super({
      filePath: path.join(paseoHome, "pr-reviews.json"),
      logger,
      schema: PrReviewRecordSchema,
      getId: (record) => record.id,
      component: "pr-review-store",
      module: "pr-review",
    });
  }
}
