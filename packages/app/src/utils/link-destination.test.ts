import { describe, expect, it } from "vitest";
import {
  resolveLinkDestination,
  type LinkBehavior,
  type ResolveLinkDestinationInput,
} from "./link-destination";

const BEHAVIORS: LinkBehavior[] = ["external", "in-app"];
const BOOLEANS = [false, true];

const MATRIX: ResolveLinkDestinationInput[] = BEHAVIORS.flatMap((behavior) =>
  BOOLEANS.flatMap((isElectron) =>
    BOOLEANS.map((hasInAppOpener) => ({ behavior, isElectron, hasInAppOpener })),
  ),
);

describe("resolveLinkDestination", () => {
  it("covers every combination of the three inputs", () => {
    expect(MATRIX).toHaveLength(8);
  });

  it("routes in-app only when the setting, the runtime, and the opener all agree", () => {
    const inApp = MATRIX.filter((input) => resolveLinkDestination(input) === "in-app");
    expect(inApp).toEqual([{ behavior: "in-app", isElectron: true, hasInAppOpener: true }]);
  });

  it("keeps the external default whatever the host offers", () => {
    const external = MATRIX.filter((input) => input.behavior === "external");
    expect(external.map(resolveLinkDestination)).toEqual(external.map(() => "external"));
  });
});
