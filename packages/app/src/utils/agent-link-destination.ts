import type { AgentLinkBehavior } from "@/hooks/use-settings";

export type AgentLinkDestination = "in-app" | "external";

export interface ResolveAgentLinkDestinationInput {
  behavior: AgentLinkBehavior;
  isElectron: boolean;
  hasInAppOpener: boolean;
}

/**
 * Where a plain tap on an agent-message link goes.
 *
 * `in-app` needs all three to line up: the user opted in, the runtime has a browser
 * to open into, and this message is hosted somewhere that can own a browser tab.
 * Anything else falls back to the system browser, which is what every platform did
 * before this setting existed.
 */
export function resolveAgentLinkDestination(
  input: ResolveAgentLinkDestinationInput,
): AgentLinkDestination {
  if (input.behavior !== "in-app") {
    return "external";
  }
  if (!input.isElectron || !input.hasInAppOpener) {
    return "external";
  }
  return "in-app";
}
