import { createContext, useCallback, useContext, type ReactNode } from "react";
// The unit suite transforms JSX with the classic runtime, so a provider rendered from a test
// needs React in scope. Same reason as assistant-file-links/provider.tsx.
import React from "react";
import { openExternalUrl } from "@/utils/open-external-url";
import { useOpenForgeLink } from "@/utils/use-link-behavior";

type ForgeLinkOpener = (url: string) => void;

const ForgeLinkContext = createContext<ForgeLinkOpener | null>(null);

function openInSystemBrowser(url: string): void {
  void openExternalUrl(url);
}

/**
 * Carries one forge-link opener down to every pull request, check, pipeline, and review
 * comment link a surface renders. Context rather than props: the PR pane's links sit four
 * levels deep in timeline cards that otherwise know nothing about the workspace hosting them,
 * and the sidebar's PR badge is rendered by a hover card mounted through a portal.
 *
 * `workspaceKey` is the workspace an in-app browser tab would belong to. A surface with no
 * workspace — a settings preview, a pane opened outside one — passes null and its links go to
 * the system browser whatever the setting says.
 */
export function ForgeLinkProvider({
  workspaceKey,
  children,
}: {
  workspaceKey: string | null;
  children: ReactNode;
}) {
  const openForgeLink = useOpenForgeLink(workspaceKey);
  return <ForgeLinkContext.Provider value={openForgeLink}>{children}</ForgeLinkContext.Provider>;
}

/**
 * Opens a forge link, honoring the Pull request links setting. Outside a provider the link
 * goes to the system browser, which is where every forge link went before the setting existed.
 */
export function useForgeLinkOpener(): ForgeLinkOpener {
  return useContext(ForgeLinkContext) ?? openInSystemBrowser;
}

/**
 * `onLinkPress` for markdown rendered from forge content — a PR body, a review comment. Returns
 * false so the renderer leaves the press to this handler.
 */
export function useForgeMarkdownLinkPress(): (url: string) => boolean {
  const openForgeLink = useForgeLinkOpener();
  return useCallback(
    (url: string) => {
      openForgeLink(url);
      return false;
    },
    [openForgeLink],
  );
}
