import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ReviewRequestPayload } from "@getpaseo/protocol/messages";
import type { PrWatchHostError, PrWatchHostInput } from "@/pull-requests/aggregated-pr-watches";
import type { ReviewRequestProjectError } from "@/pull-requests/review-request-rows";
import { toErrorMessage } from "@/utils/error-messages";

export const reviewRequestsQueryBaseKey = ["review-requests"] as const;

export interface ReviewRequestRuntime {
  getClient(serverId: string): Pick<DaemonClient, "listReviewRequests"> | null;
  getSnapshot(serverId: string): { connectionStatus: string } | null | undefined;
}

export interface HostReviewRequests {
  reviewRequests: ReviewRequestPayload[];
  errors: ReviewRequestProjectError[];
}

export interface AggregatedReviewRequests {
  /** Review requests per host. A host that was not asked, or failed, has no entry. */
  byServerId: ReadonlyMap<string, HostReviewRequests>;
  hostErrors: PrWatchHostError[];
}

/**
 * List review requests on every online host passed in. Callers pass only hosts that
 * report `features.prAutoFix`. Each host reads its GitHub projects through `gh`, so one
 * host failing lands in `hostErrors` while the rest still render.
 */
export async function fetchAggregatedReviewRequests(input: {
  hosts: readonly PrWatchHostInput[];
  runtime: ReviewRequestRuntime;
}): Promise<AggregatedReviewRequests> {
  const byServerId = new Map<string, HostReviewRequests>();
  const hostErrors: PrWatchHostError[] = [];

  await Promise.all(
    input.hosts.map(async (host) => {
      const client = input.runtime.getClient(host.serverId);
      const isOnline = input.runtime.getSnapshot(host.serverId)?.connectionStatus === "online";
      if (!client || !isOnline) return;
      try {
        byServerId.set(host.serverId, await client.listReviewRequests());
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  hostErrors.sort((left, right) => left.serverName.localeCompare(right.serverName));
  return { byServerId, hostErrors };
}
