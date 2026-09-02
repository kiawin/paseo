import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { getIsElectron } from "@/constants/platform";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  useContextMenuAnchorAtEvent,
} from "@/components/ui/context-menu";
import { openExternalUrl } from "@/utils/open-external-url";
import { useAssistantFileLinkResolverContext } from "./provider";

/**
 * The per-link destination chooser for external links in one assistant message.
 *
 * One menu per message rather than one per link: links sit mid-sentence, so a wrapper element
 * around each would turn an inline span into a block box. The links share this menu and hand it
 * the gesture point, which is what `ContextMenuTrigger` would have done for them.
 */

type OpenLinkMenu = (url: string, event: unknown) => boolean;

const AssistantLinkContextMenuContext = createContext<OpenLinkMenu | null>(null);

/** Opens the message's link menu, or `null` where no menu is mounted. */
export function useAssistantLinkContextMenu(): OpenLinkMenu | null {
  return useContext(AssistantLinkContextMenuContext);
}

export function AssistantLinkContextMenu({ children }: { children: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);
  return (
    <ContextMenu>
      <AssistantLinkContextMenuBody url={url} onTargetChange={setUrl}>
        {children}
      </AssistantLinkContextMenuBody>
    </ContextMenu>
  );
}

/**
 * Split from the component above only because `useContextMenuAnchorAtEvent` has to run inside
 * the `ContextMenu` root it anchors.
 */
function AssistantLinkContextMenuBody({
  url,
  onTargetChange,
  children,
}: {
  url: string | null;
  onTargetChange: (url: string) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { configRef } = useAssistantFileLinkResolverContext();
  const anchorAtEvent = useContextMenuAnchorAtEvent();

  const openLinkMenu = useCallback<OpenLinkMenu>(
    (nextUrl, event) => {
      onTargetChange(nextUrl);
      return anchorAtEvent(event);
    },
    [anchorAtEvent, onTargetChange],
  );

  const openInBrowserTab = configRef.current.onOpenUrlInBrowserTab;
  const handleOpenInPaseo = useCallback(() => {
    if (url) {
      configRef.current.onOpenUrlInBrowserTab?.(url);
    }
  }, [configRef, url]);

  const handleOpenExternal = useCallback(() => {
    if (url) {
      void openExternalUrl(url);
    }
  }, [url]);

  const handleCopy = useCallback(() => {
    if (!url) {
      return;
    }
    const toast = configRef.current.toast;
    void Clipboard.setStringAsync(url)
      .then(() => toast?.copied())
      .catch(() => toast?.error(t("workspace.toasts.copyFailed")));
  }, [configRef, t, url]);

  const value = useMemo(() => openLinkMenu, [openLinkMenu]);

  return (
    <AssistantLinkContextMenuContext.Provider value={value}>
      {children}
      {/*
        Only mounted once a link has actually asked for the menu. The compact presentation is a
        bottom sheet, which mounts its modal whether or not it is showing — one per assistant
        message in a long transcript, for a menu almost none of them will ever open.
      */}
      {url === null ? null : (
        <ContextMenuContent testID="assistant-link-context-menu">
          {openInBrowserTab && getIsElectron() ? (
            <ContextMenuItem onSelect={handleOpenInPaseo} testID="assistant-link-open-in-paseo">
              {t("message.actions.openLinkInPaseo")}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onSelect={handleOpenExternal} testID="assistant-link-open-in-browser">
            {t("message.actions.openLinkInBrowser")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleCopy} testID="assistant-link-copy">
            {t("message.actions.copyLink")}
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </AssistantLinkContextMenuContext.Provider>
  );
}
