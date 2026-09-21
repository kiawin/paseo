import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NoteRecordPayload } from "@getpaseo/protocol/messages";

import { useFetchQuery } from "@/data/query";
import { useHostFeature, useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
  useHostRuntimeConnectionStatuses,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { useHosts } from "@/runtime/host-runtime";
import { useWorkspaceProjectId } from "@/artifacts/hooks";
import { useWorkspaceStructure } from "@/stores/session-store-hooks";
import {
  fetchFederatedProjectNotes,
  resolveProjectNoteHosts,
  type FederatedNoteRecord,
  type NoteHostError,
  type ProjectNoteHost,
} from "./federation";
import { federatedNotesQueryKey, noteQueryKey } from "./query-keys";
import { noteReadInput } from "./read";

export { federatedNotesQueryKey, noteQueryKey, notesQueryKey } from "./query-keys";

function errorFromUnknown(error: unknown): Error | null {
  if (!error) return null;
  return error instanceof Error ? error : new Error(String(error));
}

export interface ProjectNotesResult {
  notes: FederatedNoteRecord[];
  hostErrors: NoteHostError[];
  supported: boolean;
  connectionStatus: HostRuntimeConnectionStatus;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useProjectNoteHosts(
  serverId: string,
  workspaceId: string | null,
): ProjectNoteHost[] {
  const hostProfiles = useHosts();
  const serverIds = useMemo(() => hostProfiles.map((host) => host.serverId), [hostProfiles]);
  const workspaceStructure = useWorkspaceStructure(serverIds);
  const fallbackProjectId = useWorkspaceProjectId(serverId, workspaceId);
  const hostNames = useMemo(
    () => new Map(hostProfiles.map((host) => [host.serverId, host.label] as const)),
    [hostProfiles],
  );

  return useMemo(
    () =>
      resolveProjectNoteHosts({
        projects: workspaceStructure.projects,
        anchorServerId: serverId,
        workspaceId,
        fallbackProjectId,
        hostNames,
      }),
    [fallbackProjectId, hostNames, serverId, workspaceId, workspaceStructure.projects],
  );
}

export function useProjectNoteHost(
  anchorServerId: string,
  workspaceId: string | null,
  targetServerId: string,
): ProjectNoteHost | null {
  const hosts = useProjectNoteHosts(anchorServerId, workspaceId);
  return useMemo(
    () => hosts.find((host) => host.serverId === targetServerId) ?? null,
    [hosts, targetServerId],
  );
}

export function useProjectNotes(serverId: string, workspaceId: string | null): ProjectNotesResult {
  const hosts = useProjectNoteHosts(serverId, workspaceId);
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const anchorSupported = useHostFeature(serverId, "notes");
  const anchorConnectionStatus = useHostRuntimeConnectionStatus(serverId);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const supportedByServerId = useHostFeatureAvailabilityMap(serverIds, "notes");
  const runtime = getHostRuntimeStore();
  const queryClient = useQueryClient();
  const connectionStatusKey = useMemo(
    () => serverIds.map((hostId) => connectionStatuses.get(hostId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );
  const featureKey = useMemo(
    () =>
      serverIds
        .map((hostId) => {
          const value = supportedByServerId.get(hostId);
          if (value === null) return "unknown";
          return value ? "supported" : "unsupported";
        })
        .join("|"),
    [serverIds, supportedByServerId],
  );
  const queryKey = useMemo(
    () => [...federatedNotesQueryKey(hosts), connectionStatusKey, featureKey] as const,
    [connectionStatusKey, featureKey, hosts],
  );
  const hasSettlingHost = serverIds.some((hostId) => {
    const status = connectionStatuses.get(hostId);
    return status === "idle" || status === "connecting";
  });
  const supported =
    hosts.length === 0
      ? anchorSupported
      : serverIds.some((hostId) => supportedByServerId.get(hostId) !== false);
  const connectionStatus =
    hosts.length === 0
      ? anchorConnectionStatus
      : aggregateConnectionStatus(connectionStatuses, serverIds);

  const query = useFetchQuery({
    queryKey,
    queryFn: () => {
      return fetchFederatedProjectNotes({
        hosts,
        runtime,
        supportedByServerId,
      });
    },
    enabled: hosts.length > 0,
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  useEffect(() => {
    const cleanups = hosts.flatMap((host) => {
      const owner = runtime.getNoteMetadataOwner(host.serverId);
      if (!owner) return [];
      const releaseDemand = owner.acquire(host.projectId, "list");
      return [
        owner.subscribe(() => {
          void queryClient.invalidateQueries({ queryKey: federatedNotesQueryKey(hosts) });
        }),
        () => releaseDemand(),
      ];
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [connectionStatusKey, featureKey, hosts, queryClient, runtime]);

  return {
    notes: query.data?.status === "loaded" ? query.data.notes : [],
    hostErrors: query.data?.status === "loaded" ? query.data.hostErrors : [],
    supported,
    connectionStatus,
    isLoading:
      query.isPending ||
      query.data?.status === "connecting" ||
      (hasSettlingHost && query.data === undefined) ||
      (hosts.length === 0 && workspaceId !== null),
    error: errorFromUnknown(query.error),
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface NoteResult {
  note: NoteRecordPayload | null;
  body: string | null;
  supported: boolean;
  connectionStatus: HostRuntimeConnectionStatus;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useNote(serverId: string, projectId: string | null, noteId: string): NoteResult {
  const supported = useHostFeature(serverId, "notes");
  const connectionStatus = useHostRuntimeConnectionStatus(serverId);
  const client = useHostRuntimeClient(serverId);
  const runtime = getHostRuntimeStore();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => noteQueryKey(serverId, noteId, projectId),
    [noteId, projectId, serverId],
  );
  const enabled = Boolean(noteId && supported && connectionStatus === "online" && client);

  const query = useFetchQuery({
    queryKey,
    queryFn: () => {
      if (!client || !noteId) {
        throw new Error("Notes host is not ready.");
      }
      return client.readNote(noteReadInput(noteId, projectId));
    },
    enabled,
    dataShape: "value",
    staleTimeMs: 5_000,
  });

  const resolvedProjectId = projectId ?? query.data?.note.projectId ?? null;
  const owner = runtime.getNoteMetadataOwner(serverId);
  useEffect(() => {
    if (!owner || !resolvedProjectId || !supported || connectionStatus !== "online") return;
    const releaseDemand = owner.acquire(resolvedProjectId, "note");
    const unsubscribe = owner.subscribe(() => {
      void queryClient.invalidateQueries({ queryKey });
    });
    void queryClient.invalidateQueries({ queryKey });
    return () => {
      unsubscribe();
      releaseDemand();
    };
  }, [connectionStatus, owner, queryClient, queryKey, resolvedProjectId, supported]);

  return {
    note: query.data?.note ?? null,
    body: query.data?.body ?? null,
    supported,
    connectionStatus,
    isLoading:
      connectionStatus === "connecting" ||
      connectionStatus === "idle" ||
      (enabled && query.isPending),
    error: errorFromUnknown(query.error),
    refetch: () => {
      void query.refetch();
    },
  };
}

function aggregateConnectionStatus(
  statuses: ReadonlyMap<string, HostRuntimeConnectionStatus>,
  serverIds: readonly string[],
): HostRuntimeConnectionStatus {
  const values = serverIds.map((serverId) => statuses.get(serverId) ?? "connecting");
  if (values.some((status) => status === "online")) return "online";
  if (values.some((status) => status === "idle" || status === "connecting")) {
    return "connecting";
  }
  if (values.some((status) => status === "error")) return "error";
  return "offline";
}
