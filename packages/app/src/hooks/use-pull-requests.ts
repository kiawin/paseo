import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PrWatchPayload } from "@getpaseo/protocol/messages";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useFetchQuery } from "@/data/query";
import {
  fetchAggregatedPrWatches,
  prWatchesQueryBaseKey,
  type AggregatedPrWatches,
  type PrWatchHostError,
  type PrWatchHostInput,
} from "@/pull-requests/aggregated-pr-watches";
import {
  collectPullRequestRows,
  groupPullRequestRows,
  resolveAutoFixBinding,
  type AutoFixBinding,
  type PullRequestAgentOption,
  type PullRequestRow,
  type PullRequestSection,
  type PullRequestSourceHost,
} from "@/pull-requests/pull-request-rows";
import { hostSupportsFeature } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { useSessionStore, type SessionState } from "@/stores/session-store";

export interface PullRequestListRow extends PullRequestRow {
  binding: AutoFixBinding;
  /** False while the host is offline or its watch list has not loaded, so the switch cannot act. */
  autoFixReady: boolean;
}

export type PullRequestsBodyState = "loading" | "empty" | "content";

export interface UsePullRequestsResult {
  bodyState: PullRequestsBodyState;
  sections: PullRequestSection<PullRequestListRow>[];
  hostErrors: PrWatchHostError[];
  showHostLabel: boolean;
  setAutoFix: (input: { serverId: string; agentId: string; enabled: boolean }) => Promise<void>;
}

interface PullRequestHostSession {
  serverId: string;
  workspaces: SessionState["workspaces"];
  workspaceAgentActivity: SessionState["workspaceAgentActivity"];
  hasHydratedWorkspaces: boolean;
  prAutoFix: boolean;
}

const EMPTY_WATCHES: ReadonlyMap<string, PrWatchPayload> = new Map();

function selectHostSessions(
  sessions: Record<string, SessionState | undefined>,
  serverIds: readonly string[],
): PullRequestHostSession[] {
  const selected: PullRequestHostSession[] = [];
  for (const serverId of serverIds) {
    const session = sessions[serverId];
    if (!session) continue;
    selected.push({
      serverId,
      workspaces: session.workspaces,
      workspaceAgentActivity: session.workspaceAgentActivity,
      hasHydratedWorkspaces: session.hasHydratedWorkspaces,
      prAutoFix: hostSupportsFeature(session.serverInfo, "prAutoFix"),
    });
  }
  return selected;
}

function areHostSessionsEqual(
  left: readonly PullRequestHostSession[],
  right: readonly PullRequestHostSession[],
): boolean {
  return (
    left.length === right.length &&
    left.every((session, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        session.serverId === other.serverId &&
        session.workspaces === other.workspaces &&
        session.workspaceAgentActivity === other.workspaceAgentActivity &&
        session.hasHydratedWorkspaces === other.hasHydratedWorkspaces &&
        session.prAutoFix === other.prAutoFix
      );
    })
  );
}

function isSettling(status: HostRuntimeConnectionStatus | undefined): boolean {
  return status === undefined || status === "idle" || status === "connecting";
}

/**
 * Open pull requests across every host, grouped into sections, with each row's
 * auto-fix switch bound to an agent. PR data comes from the workspace descriptors
 * already in the session store; only the watch state is fetched.
 */
export function usePullRequests(): UsePullRequestsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const queryClient = useQueryClient();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const serverNames = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label] as const)),
    [hosts],
  );
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const hostSessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectHostSessions(state.sessions, serverIds),
    areHostSessionsEqual,
  );

  const watchHosts = useMemo<PrWatchHostInput[]>(
    () =>
      hostSessions
        .filter(
          (session) => session.prAutoFix && connectionStatuses.get(session.serverId) === "online",
        )
        .map((session) => ({
          serverId: session.serverId,
          serverName: serverNames.get(session.serverId) ?? session.serverId,
        })),
    [connectionStatuses, hostSessions, serverNames],
  );
  const watchQueryKey = useMemo(
    () => [...prWatchesQueryBaseKey, watchHosts.map((host) => host.serverId).join("|")] as const,
    [watchHosts],
  );
  const watchesQuery = useFetchQuery({
    queryKey: watchQueryKey,
    queryFn: () => fetchAggregatedPrWatches({ hosts: watchHosts, runtime }),
    dataShape: "value",
    staleTimeMs: 5_000,
    // Watches pause and stop on the daemon without telling this screen.
    refetchInterval: 30_000,
    enabled: watchHosts.length > 0,
  });
  const watches: AggregatedPrWatches | undefined = watchesQuery.data;

  const rows = useMemo<PullRequestListRow[]>(() => {
    const sources: PullRequestSourceHost[] = hostSessions.map((session) => {
      const agentsByWorkspaceId = new Map<string, readonly PullRequestAgentOption[]>();
      for (const [workspaceId, activity] of session.workspaceAgentActivity) {
        agentsByWorkspaceId.set(
          workspaceId,
          activity.agents.map((agent) => ({ agentId: agent.agentId, title: agent.title })),
        );
      }
      return {
        serverId: session.serverId,
        serverName: serverNames.get(session.serverId) ?? session.serverId,
        workspaces: session.workspaces.values(),
        agentsByWorkspaceId,
      };
    });
    const supportedServerIds = new Set(
      hostSessions.filter((session) => session.prAutoFix).map((session) => session.serverId),
    );
    // The collected rows are fresh objects, so decorating them in place is safe.
    return collectPullRequestRows(sources).map((row): PullRequestListRow => {
      const hostWatches = watches?.byServerId.get(row.serverId);
      return Object.assign(row, {
        binding: resolveAutoFixBinding({
          supported: supportedServerIds.has(row.serverId),
          agents: row.agents,
          watchesByAgentId: hostWatches ?? EMPTY_WATCHES,
        }),
        autoFixReady:
          hostWatches !== undefined && connectionStatuses.get(row.serverId) === "online",
      });
    });
  }, [connectionStatuses, hostSessions, serverNames, watches]);

  const sections = useMemo(
    () =>
      groupPullRequestRows(
        rows,
        (row) => row.binding.kind === "agent" && row.binding.pausedReason !== null,
      ),
    [rows],
  );

  let bodyState: PullRequestsBodyState = "empty";
  if (rows.length > 0) {
    bodyState = "content";
  } else if (
    hosts.some((host) => {
      const status = connectionStatuses.get(host.serverId);
      if (isSettling(status)) return true;
      const session = hostSessions.find((candidate) => candidate.serverId === host.serverId);
      return status === "online" && !session?.hasHydratedWorkspaces;
    })
  ) {
    bodyState = "loading";
  }

  const setAutoFix = useCallback(
    async (input: { serverId: string; agentId: string; enabled: boolean }) => {
      const client = useSessionStore.getState().sessions[input.serverId]?.client ?? null;
      if (!client) {
        throw new Error("Host is offline");
      }
      try {
        await client.setAgentPrWatch(input.agentId, input.enabled);
      } finally {
        await queryClient.invalidateQueries({ queryKey: prWatchesQueryBaseKey });
      }
    },
    [queryClient],
  );

  return {
    bodyState,
    sections,
    hostErrors: watches?.hostErrors ?? [],
    showHostLabel: hosts.length > 1,
    setAutoFix,
  };
}
