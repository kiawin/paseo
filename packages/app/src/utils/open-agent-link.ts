import type { AgentLinkBehavior } from "@/hooks/use-settings";
import { openExternalUrl } from "@/utils/open-external-url";
import { resolveAgentLinkDestination } from "@/utils/agent-link-destination";

export async function openAgentLink(input: {
  url: string;
  behavior: AgentLinkBehavior;
  isElectron: boolean;
  openInBrowserTab?: ((url: string) => void) | null;
}): Promise<void> {
  const destination = resolveAgentLinkDestination({
    behavior: input.behavior,
    isElectron: input.isElectron,
    hasInAppOpener: Boolean(input.openInBrowserTab),
  });
  if (destination === "in-app" && input.openInBrowserTab) {
    input.openInBrowserTab(input.url);
    return;
  }
  await openExternalUrl(input.url);
}
