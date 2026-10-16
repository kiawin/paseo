import type pino from "pino";

import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  AgentPrWatchListRequest,
  AgentPrWatchSetRequest,
  PrWatchPayload,
  SessionOutboundMessage,
} from "../../messages.js";
import { PR_WATCH_MAX_ATTEMPTS_PER_HEAD, type PrWatchService } from "../../pr-watch/service.js";
import type { PrWatchRecord } from "../../pr-watch/store.js";

export interface PrWatchSessionHost {
  emit(message: SessionOutboundMessage, source?: object): void;
}

export function toPrWatchPayload(record: PrWatchRecord): PrWatchPayload {
  return {
    agentId: record.agentId,
    cwd: record.cwd,
    forge: record.forge,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    state: record.state,
    headSha: record.ci.headSha,
    attemptsForHead: record.ci.attemptsForHead,
    maxAttemptsPerHead: PR_WATCH_MAX_ATTEMPTS_PER_HEAD,
    updatedAt: record.updatedAt,
  };
}

export class PrWatchSession {
  private readonly logger: pino.Logger;

  constructor(
    private readonly host: PrWatchSessionHost,
    private readonly service: PrWatchService | null,
    logger: pino.Logger,
  ) {
    this.logger = logger.child({ module: "pr-watch-session" });
  }

  async handleSetRequest(request: AgentPrWatchSetRequest, source?: object): Promise<void> {
    const { requestId } = request;
    try {
      const record = await this.requireService().setWatch({
        agentId: request.agentId,
        enabled: request.enabled,
      });
      this.host.emit(
        {
          type: "agent.pr_watch.set.response",
          payload: {
            watch: record ? toPrWatchPayload(record) : null,
            success: true,
            error: null,
            requestId,
          },
        },
        source,
      );
    } catch (error) {
      this.logger.info({ err: error, agentId: request.agentId }, "pr-watch.set.failed");
      this.host.emit(
        {
          type: "agent.pr_watch.set.response",
          payload: { watch: null, success: false, error: getErrorMessage(error), requestId },
        },
        source,
      );
    }
  }

  async handleListRequest(request: AgentPrWatchListRequest, source?: object): Promise<void> {
    const { requestId } = request;
    try {
      const records = await this.requireService().list();
      const watches = records
        .filter((record) => request.agentId === undefined || record.agentId === request.agentId)
        .map(toPrWatchPayload);
      this.host.emit(
        {
          type: "agent.pr_watch.list.response",
          payload: { watches, success: true, error: null, requestId },
        },
        source,
      );
    } catch (error) {
      this.host.emit(
        {
          type: "agent.pr_watch.list.response",
          payload: { watches: [], success: false, error: getErrorMessage(error), requestId },
        },
        source,
      );
    }
  }

  private requireService(): PrWatchService {
    if (!this.service) throw new Error("PR auto-fix is not available on this daemon");
    return this.service;
  }
}
