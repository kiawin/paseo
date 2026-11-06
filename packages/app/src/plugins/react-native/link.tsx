import type { LinkProps } from "@getpaseo/plugin/client/ui";
import { ExternalLink } from "@/components/ui/external-link";
import { useOpenLink } from "../use-open-link";

export function Link({ kind, ...props }: LinkProps) {
  const openUrl = useOpenLink(kind);
  return <ExternalLink {...props} openUrl={openUrl} />;
}
