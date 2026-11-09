import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

interface ProjectDefaultHostStoreState {
  /**
   * Keyed by `SidebarProjectEntry.viewKey`, the identity a project keeps across hosts. App-local
   * because the choice is between daemons, and daemons never talk to each other.
   */
  defaultServerIdByProject: Record<string, string>;
  /** `null` clears the choice, so the project goes back to the automatic host. */
  setDefaultServerId: (projectViewKey: string, serverId: string | null) => void;
}

const ProjectDefaultHostPersistedStateSchema = z.strictObject({
  defaultServerIdByProject: z.record(z.string(), z.string()),
});

export const useProjectDefaultHostStore = create<ProjectDefaultHostStoreState>()(
  persist(
    (set) => ({
      defaultServerIdByProject: {},
      setDefaultServerId: (projectViewKey, serverId) => {
        set((state) => {
          const { [projectViewKey]: _previous, ...rest } = state.defaultServerIdByProject;
          return {
            defaultServerIdByProject: serverId ? { ...rest, [projectViewKey]: serverId } : rest,
          };
        });
      },
    }),
    {
      name: "project-default-host",
      storage: createValidatedPersistStorage(AsyncStorage, ProjectDefaultHostPersistedStateSchema),
      partialize: (state) => ({ defaultServerIdByProject: state.defaultServerIdByProject }),
      version: 1,
    },
  ),
);
