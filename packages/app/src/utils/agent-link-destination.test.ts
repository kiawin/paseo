import { describe, expect, it } from "vitest";
import type { AgentLinkBehavior } from "@/hooks/use-settings";
import {
  resolveAgentLinkDestination,
  type ResolveAgentLinkDestinationInput,
} from "./agent-link-destination";

const BEHAVIORS: AgentLinkBehavior[] = ["external", "in-app"];
const BOOLEANS = [false, true];

const MATRIX: ResolveAgentLinkDestinationInput[] = BEHAVIORS.flatMap((behavior) =>
  BOOLEANS.flatMap((isElectron) =>
    BOOLEANS.map((hasInAppOpener) => ({ behavior, isElectron, hasInAppOpener })),
  ),
);

describe("resolveAgentLinkDestination", () => {
  it("covers every combination of the three inputs", () => {
    expect(MATRIX).toHaveLength(8);
  });

  it("routes in-app only when the setting, the runtime, and the opener all agree", () => {
    const inApp = MATRIX.filter((input) => resolveAgentLinkDestination(input) === "in-app");
    expect(inApp).toEqual([{ behavior: "in-app", isElectron: true, hasInAppOpener: true }]);
  });

  it("keeps the external default whatever the host offers", () => {
    const external = MATRIX.filter((input) => input.behavior === "external");
    expect(external.map(resolveAgentLinkDestination)).toEqual(external.map(() => "external"));
  });
});
