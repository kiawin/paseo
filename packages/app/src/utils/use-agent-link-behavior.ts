import { useCallback } from "react";
import { useOpenUrlInWorkspaceBrowserTab } from "@/desktop/browser/open-in-workspace";
import { isElectronRuntime } from "@/desktop/host";
import { useSettings } from "@/hooks/use-settings";
import { openAgentLink } from "@/utils/open-agent-link";

export function useOpenAgentLink(workspaceKey: string | null): (url: string) => void {
  const behavior = useSettings((settings) => settings.agentLinkBehavior);
  const openInBrowserTab = useOpenUrlInWorkspaceBrowserTab(workspaceKey);

  return useCallback(
    (url: string) => {
      void openAgentLink({
        url,
        behavior,
        isElectron: isElectronRuntime(),
        openInBrowserTab,
      });
    },
    [behavior, openInBrowserTab],
  );
}
