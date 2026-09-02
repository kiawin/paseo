import { openExternalUrl } from "@/utils/open-external-url";
import { resolveLinkDestination, type LinkBehavior } from "@/utils/link-destination";

export async function openLink(input: {
  url: string;
  behavior: LinkBehavior;
  isElectron: boolean;
  openInBrowserTab?: ((url: string) => void) | null;
}): Promise<void> {
  const destination = resolveLinkDestination({
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
