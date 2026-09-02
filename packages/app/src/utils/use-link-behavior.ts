import { useCallback } from "react";
import { useOpenUrlInWorkspaceBrowserTab } from "@/desktop/browser/open-in-workspace";
import { isElectronRuntime } from "@/desktop/host";
import { useSettings } from "@/hooks/use-settings";
import type { LinkBehavior } from "@/utils/link-destination";
import { openLink } from "@/utils/open-link";

function useOpenLink(behavior: LinkBehavior, workspaceKey: string | null): (url: string) => void {
  const openInBrowserTab = useOpenUrlInWorkspaceBrowserTab(workspaceKey);

  return useCallback(
    (url: string) => {
      void openLink({
        url,
        behavior,
        isElectron: isElectronRuntime(),
        openInBrowserTab,
      });
    },
    [behavior, openInBrowserTab],
  );
}

/** Opens a link an agent published, honoring the Agent links setting. */
export function useOpenAgentLink(workspaceKey: string | null): (url: string) => void {
  const behavior = useSettings((settings) => settings.agentLinkBehavior);
  return useOpenLink(behavior, workspaceKey);
}

/**
 * Opens a link into a git forge — a pull request, a CI check, a review comment — honoring the
 * Pull request links setting. Every forge link Paseo renders goes through this, so the setting
 * can't hold for the PR panel and not for the sidebar badge that opens the same page.
 */
export function useOpenForgeLink(workspaceKey: string | null): (url: string) => void {
  const behavior = useSettings((settings) => settings.forgeLinkBehavior);
  return useOpenLink(behavior, workspaceKey);
}
