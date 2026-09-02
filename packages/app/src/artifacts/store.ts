import { create } from "zustand";
import type { ArtifactRecordPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface ArtifactListState {
  artifacts: ArtifactRecordPayload[];
  isLoading: boolean;
  error: string | null;
}

export interface ArtifactContentState {
  html: string | null;
  /** Digest the cached html was fetched at, so a republish invalidates it. */
  contentSha256: string | null;
  /**
   * Digest of the load in flight, if one is.
   *
   * The version is what makes this more than an `isLoading` flag: a republish arriving mid-load
   * asks for a different digest, and both "is a load already covering this?" and "is the result
   * still wanted?" are answered by comparing against it.
   */
  loadingSha256: string | null;
  isLoading: boolean;
  error: string | null;
}

const EMPTY_LIST: ArtifactListState = { artifacts: [], isLoading: false, error: null };
const EMPTY_CONTENT: ArtifactContentState = {
  html: null,
  contentSha256: null,
  loadingSha256: null,
  isLoading: false,
  error: null,
};

function listKey(serverId: string, projectId: string): string {
  return `${serverId}:${projectId}`;
}

function contentKey(serverId: string, artifactId: string): string {
  return `${serverId}:${artifactId}`;
}

interface ArtifactsState {
  lists: Record<string, ArtifactListState | undefined>;
  contents: Record<string, ArtifactContentState | undefined>;
  refreshList(input: { client: DaemonClient; serverId: string; projectId: string }): Promise<void>;
  loadContent(input: {
    client: DaemonClient;
    serverId: string;
    artifactId: string;
    contentSha256: string;
  }): Promise<void>;
  forgetServer(serverId: string): void;
}

export const useArtifactsStore = create<ArtifactsState>((set, get) => ({
  lists: {},
  contents: {},

  refreshList: async ({ client, serverId, projectId }) => {
    const key = listKey(serverId, projectId);
    const previous = get().lists[key] ?? EMPTY_LIST;
    set((state) => ({
      lists: { ...state.lists, [key]: { ...previous, isLoading: true, error: null } },
    }));
    try {
      const artifacts = await client.listArtifacts(projectId);
      set((state) => ({
        lists: { ...state.lists, [key]: { artifacts, isLoading: false, error: null } },
      }));
    } catch (error) {
      set((state) => ({
        lists: {
          ...state.lists,
          [key]: {
            artifacts: previous.artifacts,
            isLoading: false,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      }));
    }
  },

  loadContent: async ({ client, serverId, artifactId, contentSha256 }) => {
    const key = contentKey(serverId, artifactId);
    const cached = get().contents[key];
    if (cached?.contentSha256 === contentSha256 && cached.html !== null) return;
    // Only a load for this same version is worth waiting on. One for a superseded digest is
    // about to be discarded, so returning here would leave the pane on the old document until
    // something else invalidated it.
    if (cached?.loadingSha256 === contentSha256) return;
    set((state) => ({
      contents: {
        ...state.contents,
        [key]: { ...EMPTY_CONTENT, loadingSha256: contentSha256, isLoading: true },
      },
    }));
    try {
      const chunks: Uint8Array[] = [];
      await client.downloadArtifact({
        artifactId,
        sink: {
          onChunk: (chunk: Uint8Array) => {
            chunks.push(chunk);
          },
        },
      });
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      set((state) => {
        // Superseded while this was in flight: a newer digest owns the slot, and committing
        // here would overwrite it with the older document.
        if (state.contents[key]?.loadingSha256 !== contentSha256) return state;
        return {
          contents: {
            ...state.contents,
            [key]: {
              html: new TextDecoder().decode(merged),
              contentSha256,
              loadingSha256: null,
              isLoading: false,
              error: null,
            },
          },
        };
      });
    } catch (error) {
      set((state) => {
        if (state.contents[key]?.loadingSha256 !== contentSha256) return state;
        return {
          contents: {
            ...state.contents,
            [key]: {
              html: null,
              contentSha256: null,
              loadingSha256: null,
              isLoading: false,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      });
    }
  },

  forgetServer: (serverId) => {
    const prefix = `${serverId}:`;
    set((state) => ({
      lists: Object.fromEntries(
        Object.entries(state.lists).filter(([key]) => !key.startsWith(prefix)),
      ),
      contents: Object.fromEntries(
        Object.entries(state.contents).filter(([key]) => !key.startsWith(prefix)),
      ),
    }));
  },
}));

export function selectArtifactList(
  state: ArtifactsState,
  serverId: string,
  projectId: string,
): ArtifactListState {
  return state.lists[listKey(serverId, projectId)] ?? EMPTY_LIST;
}

export function selectArtifactContent(
  state: ArtifactsState,
  serverId: string,
  artifactId: string,
): ArtifactContentState {
  return state.contents[contentKey(serverId, artifactId)] ?? EMPTY_CONTENT;
}
