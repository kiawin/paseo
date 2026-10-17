import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useFetchQuery } from "@/data/query";
import type { PrWatchHostInput } from "@/pull-requests/aggregated-pr-watches";
import {
  fetchAggregatedReviewRequests,
  reviewRequestsQueryBaseKey,
  type AggregatedReviewRequests,
} from "@/pull-requests/aggregated-review-requests";
import {
  collectReviewRequestRows,
  describeReviewRequestErrors,
  type ReviewRequestErrorLine,
  type ReviewRequestRow,
  type ReviewRequestSourceHost,
} from "@/pull-requests/review-request-rows";
import { hostSupportsFeature } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore, type SessionState } from "@/stores/session-store";

export type ReviewRequestsState =
  /** No online host runs PR automation, so there is nothing to ask. */
  | { status: "unsupported" }
  | { status: "loading" }
  | { status: "loaded"; rows: ReviewRequestRow[]; errors: ReviewRequestErrorLine[] };

export interface StartReviewInput {
  serverId: string;
  projectId: string;
  prNumber: number;
}

export interface UseReviewRequestsResult {
  state: ReviewRequestsState;
  /** Resolves to the reviewer's workspace, or null when the daemon has not made one yet. */
  startReview: (input: StartReviewInput) => Promise<string | null>;
}

interface ReviewRequestHostSession {
  serverId: string;
  projects: SessionState["projects"];
  prAutoFix: boolean;
}

function selectHostSessions(
  sessions: Record<string, SessionState | undefined>,
  serverIds: readonly string[],
): ReviewRequestHostSession[] {
  const selected: ReviewRequestHostSession[] = [];
  for (const serverId of serverIds) {
    const session = sessions[serverId];
    if (!session) continue;
    selected.push({
      serverId,
      projects: session.projects,
      prAutoFix: hostSupportsFeature(session.serverInfo, "prAutoFix"),
    });
  }
  return selected;
}

function areHostSessionsEqual(
  left: readonly ReviewRequestHostSession[],
  right: readonly ReviewRequestHostSession[],
): boolean {
  return (
    left.length === right.length &&
    left.every((session, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        session.serverId === other.serverId &&
        session.projects === other.projects &&
        session.prAutoFix === other.prAutoFix
      );
    })
  );
}

function projectNamesOf(projects: SessionState["projects"]): Map<string, string> {
  const names = new Map<string, string>();
  for (const project of projects.values()) {
    names.set(project.projectId, project.projectDisplayName);
  }
  return names;
}

/**
 * Pull requests where someone asked you for a review, across every online host that
 * runs PR automation. Each host asks GitHub through `gh`, so the list refreshes on a
 * slow interval and whenever the screen comes back into focus.
 */
export function useReviewRequests(): UseReviewRequestsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const queryClient = useQueryClient();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const hostSessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectHostSessions(state.sessions, serverIds),
    areHostSessionsEqual,
  );

  const queryHosts = useMemo<PrWatchHostInput[]>(() => {
    const labels = new Map(hosts.map((host) => [host.serverId, host.label] as const));
    return hostSessions
      .filter(
        (session) => session.prAutoFix && connectionStatuses.get(session.serverId) === "online",
      )
      .map((session) => ({
        serverId: session.serverId,
        serverName: labels.get(session.serverId) ?? session.serverId,
      }));
  }, [connectionStatuses, hostSessions, hosts]);
  const queryKey = useMemo(
    () =>
      [...reviewRequestsQueryBaseKey, queryHosts.map((host) => host.serverId).join("|")] as const,
    [queryHosts],
  );
  const query = useFetchQuery({
    queryKey,
    queryFn: () => fetchAggregatedReviewRequests({ hosts: queryHosts, runtime }),
    dataShape: "value",
    // The screen remounts on focus, so a stale answer refetches when you come back.
    staleTimeMs: 15_000,
    refetchInterval: 60_000,
    enabled: queryHosts.length > 0,
  });
  const aggregated: AggregatedReviewRequests | undefined = query.data;

  const state = useMemo<ReviewRequestsState>(() => {
    if (queryHosts.length === 0) return { status: "unsupported" };
    if (!aggregated) return { status: "loading" };
    const sources: ReviewRequestSourceHost[] = [];
    for (const host of queryHosts) {
      const answer = aggregated.byServerId.get(host.serverId);
      const session = hostSessions.find((candidate) => candidate.serverId === host.serverId);
      if (!answer || !session) continue;
      sources.push({
        serverId: host.serverId,
        serverName: host.serverName,
        reviewRequests: answer.reviewRequests,
        errors: answer.errors,
        projectNames: projectNamesOf(session.projects),
      });
    }
    return {
      status: "loaded",
      rows: collectReviewRequestRows(sources),
      errors: describeReviewRequestErrors({
        hosts: sources,
        hostErrors: aggregated.hostErrors,
      }),
    };
  }, [aggregated, hostSessions, queryHosts]);

  const startReview = useCallback(
    async (input: StartReviewInput) => {
      const client = useSessionStore.getState().sessions[input.serverId]?.client ?? null;
      if (!client) {
        throw new Error("Host is offline");
      }
      try {
        const review = await client.startPrReview({
          projectId: input.projectId,
          prNumber: input.prNumber,
        });
        return review.workspaceId;
      } finally {
        await queryClient.invalidateQueries({ queryKey: reviewRequestsQueryBaseKey });
      }
    },
    [queryClient],
  );

  return { state, startReview };
}
