import type pino from "pino";

import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  ProjectReviewRequestsListRequest,
  ProjectReviewRequestsReviewRequest,
  SessionOutboundMessage,
} from "../../messages.js";
import { toPrReviewPayload, toReviewRequestPayload } from "../../pr-review/payload.js";
import type { PrReviewService } from "../../pr-review/service.js";

export interface PrReviewSessionHost {
  emit(message: SessionOutboundMessage, source?: object): void;
}

export class PrReviewSession {
  private readonly logger: pino.Logger;

  constructor(
    private readonly host: PrReviewSessionHost,
    private readonly service: PrReviewService | null,
    logger: pino.Logger,
  ) {
    this.logger = logger.child({ module: "pr-review-session" });
  }

  async handleListRequest(
    request: ProjectReviewRequestsListRequest,
    source?: object,
  ): Promise<void> {
    const { requestId } = request;
    try {
      const result = await this.requireService().listReviewRequests(request.projectId);
      this.host.emit(
        {
          type: "project.review_requests.list.response",
          payload: {
            requestId,
            reviewRequests: result.requests.map(toReviewRequestPayload),
            errors: result.errors,
            success: true,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.host.emit(
        {
          type: "project.review_requests.list.response",
          payload: {
            requestId,
            reviewRequests: [],
            errors: [],
            success: false,
            error: getErrorMessage(error),
          },
        },
        source,
      );
    }
  }

  async handleReviewRequest(
    request: ProjectReviewRequestsReviewRequest,
    source?: object,
  ): Promise<void> {
    const { requestId } = request;
    try {
      const record = await this.requireService().startReview({
        projectId: request.projectId,
        prNumber: request.prNumber,
        ...(request.provider ? { provider: request.provider } : {}),
      });
      this.host.emit(
        {
          type: "project.review_requests.review.response",
          payload: { requestId, review: toPrReviewPayload(record), success: true, error: null },
        },
        source,
      );
    } catch (error) {
      this.logger.info(
        { err: error, projectId: request.projectId, prNumber: request.prNumber },
        "pr-review.start.failed",
      );
      this.host.emit(
        {
          type: "project.review_requests.review.response",
          payload: { requestId, review: null, success: false, error: getErrorMessage(error) },
        },
        source,
      );
    }
  }

  private requireService(): PrReviewService {
    if (!this.service) throw new Error("PR reviews are not available on this daemon");
    return this.service;
  }
}
