import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PrWatchPayload } from "@getpaseo/protocol/messages";
import { toErrorMessage } from "@/utils/error-messages";

export const prWatchesQueryBaseKey = ["pr-watches"] as const;

export interface PrWatchHostInput {
  serverId: string;
  serverName: string;
}

export interface PrWatchRuntime {
  getClient(serverId: string): Pick<DaemonClient, "listAgentPrWatches"> | null;
  getSnapshot(serverId: string): { connectionStatus: string } | null | undefined;
}

export interface PrWatchHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface AggregatedPrWatches {
  /** Watches per host, keyed by agent id. A host that was not asked has no entry. */
  byServerId: ReadonlyMap<string, ReadonlyMap<string, PrWatchPayload>>;
  hostErrors: PrWatchHostError[];
}

/**
 * List PR auto-fix watches on every online host passed in. Callers pass only hosts
 * that report `features.prAutoFix`. A host that fails lands in `hostErrors` while
 * the rest still render: the PR rows come from workspace descriptors, so a failed
 * watch list costs only that host's switch state, never the list itself.
 */
export async function fetchAggregatedPrWatches(input: {
  hosts: readonly PrWatchHostInput[];
  runtime: PrWatchRuntime;
}): Promise<AggregatedPrWatches> {
  const byServerId = new Map<string, ReadonlyMap<string, PrWatchPayload>>();
  const hostErrors: PrWatchHostError[] = [];

  await Promise.all(
    input.hosts.map(async (host) => {
      const client = input.runtime.getClient(host.serverId);
      const isOnline = input.runtime.getSnapshot(host.serverId)?.connectionStatus === "online";
      if (!client || !isOnline) return;
      try {
        const watches = await client.listAgentPrWatches();
        byServerId.set(host.serverId, new Map(watches.map((watch) => [watch.agentId, watch])));
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
