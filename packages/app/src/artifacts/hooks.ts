import { useCallback, useEffect, useMemo } from "react";
import type { ArtifactRecordPayload } from "@getpaseo/protocol/messages";

import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import {
  selectArtifactContent,
  selectArtifactList,
  useArtifactsStore,
  type ArtifactContentState,
  type ArtifactListState,
} from "@/artifacts/store";

/**
 * The Explorer keys its state by checkout while artifacts are keyed by project, so the
 * checkout -> workspace -> projectId hop happens here rather than being threaded through the
 * explorer's checkout plumbing.
 */
export function useWorkspaceProjectId(
  serverId: string | null,
  workspaceId: string | null,
): string | null {
  return useSessionStore((state) => {
    if (!serverId || !workspaceId) return null;
    return state.sessions[serverId]?.workspaces.get(workspaceId)?.projectId ?? null;
  });
}

export interface ProjectArtifacts extends ArtifactListState {
  supported: boolean;
  refresh: () => void;
  remove: (artifactId: string) => Promise<void>;
  setPinned: (artifactId: string, pinned: boolean) => Promise<void>;
}

export function useProjectArtifacts(serverId: string, projectId: string | null): ProjectArtifacts {
  const supported = useHostFeature(serverId, "artifacts");
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const refreshList = useArtifactsStore((state) => state.refreshList);
  const list = useArtifactsStore((state) =>
    projectId ? selectArtifactList(state, serverId, projectId) : null,
  );

  const refresh = useCallback(() => {
    if (!client || !projectId || !supported) return;
    void refreshList({ client, serverId, projectId });
  }, [client, projectId, refreshList, serverId, supported]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The daemon pushes one invalidation per project rather than the new list: a publish can
  // arrive from any agent on any workspace, and refetching is cheaper than reconciling.
  useEffect(() => {
    if (!client || !projectId || !supported) return;
    return client.on("artifact.changed", (message) => {
      if (message.payload.projectId !== projectId) return;
      void refreshList({ client, serverId, projectId });
    });
  }, [client, projectId, refreshList, serverId, supported]);

  const remove = useCallback(
    async (artifactId: string) => {
      if (!client) return;
      await client.deleteArtifact(artifactId);
    },
    [client],
  );

  const setPinned = useCallback(
    async (artifactId: string, pinned: boolean) => {
      if (!client) return;
      await client.setArtifactPinned(artifactId, pinned);
    },
    [client],
  );

  return useMemo(
    () => ({
      artifacts: list?.artifacts ?? [],
      isLoading: list?.isLoading ?? false,
      error: list?.error ?? null,
      supported,
      refresh,
      remove,
      setPinned,
    }),
    [list, refresh, remove, setPinned, supported],
  );
}

export function useArtifactRecord(
  serverId: string,
  artifactId: string,
): ArtifactRecordPayload | null {
  return useArtifactsStore((state) => {
    for (const list of Object.values(state.lists)) {
      const found = list?.artifacts.find((artifact) => artifact.artifactId === artifactId);
      if (found) return found;
    }
    return null;
  });
}

export function useArtifactContent(
  serverId: string,
  artifactId: string,
  contentSha256: string | null,
): ArtifactContentState {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const loadContent = useArtifactsStore((state) => state.loadContent);
  const content = useArtifactsStore((state) => selectArtifactContent(state, serverId, artifactId));

  useEffect(() => {
    if (!client || !contentSha256) return;
    void loadContent({ client, serverId, artifactId, contentSha256 });
  }, [artifactId, client, contentSha256, loadContent, serverId]);

  return content;
}
