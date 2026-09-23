import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export type AgentToolsWorkspace = Pick<
  SidebarWorkspaceEntry,
  "serverId" | "workspaceId" | "workspaceKey" | "agentToolsEnabled"
>;

export type ToggleSidebarWorkspaceAgentTools = (workspace: AgentToolsWorkspace) => void;

const pendingWorkspaceKeys = new Set<string>();

export function useSidebarWorkspaceAgentToolsController(): ToggleSidebarWorkspaceAgentTools {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async ({
      workspace,
      enabled,
    }: {
      workspace: AgentToolsWorkspace;
      enabled: boolean;
    }) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await client.setWorkspaceAgentTools(workspace.workspaceId, enabled);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.hostDisconnected"),
      );
    },
    onSettled: (_data, _error, { workspace }) => {
      pendingWorkspaceKeys.delete(workspace.workspaceKey);
    },
  });
  const mutate = mutation.mutate;

  return useCallback(
    (workspace) => {
      if (pendingWorkspaceKeys.has(workspace.workspaceKey)) return;
      pendingWorkspaceKeys.add(workspace.workspaceKey);
      mutate({ workspace, enabled: workspace.agentToolsEnabled === false });
    },
    [mutate],
  );
}
