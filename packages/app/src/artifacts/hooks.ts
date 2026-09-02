import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactRecordPayload, ArtifactSearchMatch } from "@getpaseo/protocol/messages";

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
  renameSupported: boolean;
  refresh: () => void;
  remove: (artifactId: string) => Promise<void>;
  setPinned: (artifactId: string, pinned: boolean) => Promise<void>;
  rename: (artifactId: string, title: string | null) => Promise<void>;
}

export function useProjectArtifacts(serverId: string, projectId: string | null): ProjectArtifacts {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "artifacts");
  const invalidationSupported = useHostFeature(serverId, "artifactInvalidation");
  const renameSupported = useHostFeature(serverId, "artifactRename");
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
    const onChanged = (changedProjectId: string) => {
      if (changedProjectId === projectId) void refreshList({ client, serverId, projectId });
    };
    if (!invalidationSupported) {
      return client.on("artifact.changed", (message) => onChanged(message.payload.projectId));
    }
    const subscription = client.observeArtifactChanges();
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "artifact.changed") onChanged(message.payload.projectId);
      },
    });
    void subscription.ready.catch(() => {
      void subscription.release().catch(() => undefined);
    });
    return () => {
      void subscription.release().catch(() => undefined);
    };
  }, [client, invalidationSupported, projectId, refreshList, serverId, supported]);

  const remove = useCallback(
    async (artifactId: string) => {
      if (!client) return;
      await client.deleteArtifact(artifactId);
      if (projectId) await refreshList({ client, serverId, projectId });
    },
    [client, projectId, refreshList, serverId],
  );

  const setPinned = useCallback(
    async (artifactId: string, pinned: boolean) => {
      if (!client) return;
      await client.setArtifactPinned(artifactId, pinned);
      if (projectId) await refreshList({ client, serverId, projectId });
    },
    [client, projectId, refreshList, serverId],
  );

  const rename = useCallback(
    async (artifactId: string, title: string | null) => {
      if (!client || !renameSupported) throw new Error(t("panels.artifacts.renameFailed"));
      await client.renameArtifact(artifactId, title);
      if (projectId) await refreshList({ client, serverId, projectId });
    },
    [client, projectId, refreshList, renameSupported, serverId, t],
  );

  return useMemo(
    () => ({
      artifacts: list?.artifacts ?? [],
      isLoading: list?.isLoading ?? false,
      error: list?.error ?? null,
      supported,
      renameSupported,
      refresh,
      remove,
      setPinned,
      rename,
    }),
    [list, refresh, remove, setPinned, rename, renameSupported, supported],
  );
}

interface ArtifactSearchResult {
  projectId: string;
  query: string;
  artifacts: ArtifactRecordPayload[];
  matches: ArtifactSearchMatch[];
  error: boolean;
  attempt: number;
}

function matchesArtifactTitle(artifact: ArtifactRecordPayload, terms: string[]): boolean {
  const titles = [artifact.title.toLowerCase(), artifact.customTitle?.toLowerCase() ?? ""];
  return terms.every((term) => titles.some((title) => title.includes(term)));
}

export function useArtifactSearch(
  serverId: string,
  projectId: string | null,
  artifacts: ArtifactRecordPayload[],
  query: string,
) {
  const contentSearchSupported = useHostFeature(serverId, "artifactSearch");
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
  const [result, setResult] = useState<ArtifactSearchResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!contentSearchSupported || !client || !projectId || !normalizedQuery || !artifacts.length) {
      return;
    }
    let active = true;
    const timeout = setTimeout(() => {
      void (async () => {
        try {
          const matches = await client.searchArtifacts(projectId, normalizedQuery);
          if (active) {
            setResult({
              projectId,
              query: normalizedQuery,
              artifacts,
              matches,
              error: false,
              attempt,
            });
          }
        } catch {
          if (active) {
            setResult({
              projectId,
              query: normalizedQuery,
              artifacts,
              matches: [],
              error: true,
              attempt,
            });
          }
        }
      })();
    }, 300);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [artifacts, attempt, client, contentSearchSupported, normalizedQuery, projectId]);

  const current =
    result?.projectId === projectId &&
    result.query === normalizedQuery &&
    result.attempt === attempt &&
    result.artifacts === artifacts
      ? result
      : null;
  const matchingArtifacts = useMemo(() => {
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return artifacts;
    if (current && !current.error) {
      const ids = new Set(current.matches.map((match) => match.artifactId));
      return artifacts.filter((artifact) => ids.has(artifact.artifactId));
    }
    return artifacts.filter((artifact) => matchesArtifactTitle(artifact, terms));
  }, [artifacts, current, normalizedQuery]);
  const snippetsById = useMemo(
    () => new Map(current?.matches.map((match) => [match.artifactId, match.snippet] as const)),
    [current],
  );

  return {
    contentSearchSupported,
    matchingArtifacts,
    snippetsById,
    hasQuery: normalizedQuery.length > 0,
    pending: Boolean(contentSearchSupported && client && normalizedQuery && !current),
    failed:
      current?.error === true || Boolean(contentSearchSupported && normalizedQuery && !client),
    retry,
  };
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
