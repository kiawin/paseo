/** The pair of answers both link settings resolve to. */
export type LinkDestination = "in-app" | "external";

/** A link setting's stored value. Same pair, before the runtime gets a say. */
export type LinkBehavior = LinkDestination;

export interface ResolveLinkDestinationInput {
  behavior: LinkBehavior;
  isElectron: boolean;
  hasInAppOpener: boolean;
}

/**
 * Where a plain tap on an external link goes.
 *
 * `in-app` needs all three to line up: the user opted in, the runtime has a browser to open
 * into, and the surface holding the link is hosted somewhere that can own a browser tab.
 * Anything else falls back to the system browser, which is what every platform did before
 * these settings existed.
 */
export function resolveLinkDestination(input: ResolveLinkDestinationInput): LinkDestination {
  if (input.behavior !== "in-app") {
    return "external";
  }
  if (!input.isElectron || !input.hasInAppOpener) {
    return "external";
  }
  return "in-app";
}
