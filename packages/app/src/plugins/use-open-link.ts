import { useCallback } from "react";
import type { PluginLinkKind } from "@getpaseo/plugin/client";
import { useAssistantFileLinkResolverContext } from "@/assistant-file-links/provider";
import { isElectronRuntime } from "@/desktop/host";
import { useAppSettings } from "@/hooks/use-settings";
import { isHttpUrl } from "@/utils/http-url";
import { openLink } from "@/utils/open-link";

/** Use the containing workspace's opener; screens without a workspace open externally. */
export function useOpenLink(kind: PluginLinkKind = "agent"): (url: string) => Promise<void> {
  // Link behaviors are app settings. `useSettings` also loads desktop settings, whose error
  // toast needs a ToastProvider that markdown rendered outside the full app tree lacks.
  const { settings } = useAppSettings();
  const behavior = kind === "forge" ? settings.forgeLinkBehavior : settings.agentLinkBehavior;
  const { configRef } = useAssistantFileLinkResolverContext();
  return useCallback(
    async (url: string) => {
      if (!isHttpUrl(url)) return;
      await openLink({
        url,
        behavior,
        isElectron: isElectronRuntime(),
        openInBrowserTab: configRef.current.onOpenUrlInBrowserTab,
      });
    },
    [behavior, configRef],
  );
}
