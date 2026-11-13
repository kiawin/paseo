import { useCallback, useMemo } from "react";
import { getIsElectron } from "@/constants/platform";
import { BrowserIdAlreadyExistsError, createWorkspaceBrowser } from "@/desktop/browser/store";
import { FOCUSED_PANE_PLACEMENT, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

/**
 * Opens a URL as a browser tab in one workspace, or `null` where that is not possible —
 * outside Electron, or without a workspace to own the tab. Callers use the null to decide
 * whether an in-app destination is offered at all, so keep the two answers in one place.
 */
export function useOpenUrlInWorkspaceBrowserTab(
  workspaceKey: string | null,
): ((url: string, browserId?: string) => void) | null {
  const openTab = useWorkspaceLayoutStore((state) => state.openTab);
  const openUrl = useCallback(
    (url: string, reservedBrowserId?: string) => {
      if (!workspaceKey) {
        return;
      }
      let browserId: string;
      try {
        ({ browserId } = createWorkspaceBrowser({ initialUrl: url, browserId: reservedBrowserId }));
      } catch (error) {
        if (!reservedBrowserId || !(error instanceof BrowserIdAlreadyExistsError)) {
          throw error;
        }
        // The recording reservation expires as a visible capture gap.
        ({ browserId } = createWorkspaceBrowser({ initialUrl: url }));
      }
      openTab({
        workspaceKey,
        target: { kind: "browser", browserId },
        intent: "reveal",
        placement: FOCUSED_PANE_PLACEMENT,
      });
    },
    [openTab, workspaceKey],
  );

  return useMemo(() => (workspaceKey && getIsElectron() ? openUrl : null), [openUrl, workspaceKey]);
}
