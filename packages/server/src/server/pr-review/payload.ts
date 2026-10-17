import type { PrReviewPayload, ReviewRequestPayload } from "@getpaseo/protocol/messages";

import type { ReviewRequest } from "./service.js";
import type { PrReviewRecord } from "./store.js";

export function toPrReviewPayload(record: PrReviewRecord): PrReviewPayload {
  return {
    projectId: record.projectId,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    agentId: record.agentId,
    workspaceId: record.workspaceId,
    reviewedHeadSha: record.reviewedHeadSha,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toReviewRequestPayload(request: ReviewRequest): ReviewRequestPayload {
  const { pullRequest } = request;
  return {
    projectId: request.projectId,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author ?? null,
    baseRefName: pullRequest.baseRefName,
    headRefName: pullRequest.headRefName,
    headSha: pullRequest.headSha ?? null,
    isDraft: pullRequest.isDraft ?? false,
    isCrossRepository: pullRequest.isCrossRepository ?? true,
    updatedAt: pullRequest.updatedAt,
    review: request.review ? toPrReviewPayload(request.review) : null,
  };
}
