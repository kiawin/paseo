import type { PrWatchPayload } from "../messages.js";
import { PR_WATCH_MAX_ATTEMPTS_PER_HEAD } from "./service.js";
import type { PrWatchRecord } from "./store.js";

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
