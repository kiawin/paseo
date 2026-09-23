import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import {
  getAgentLineageReachabilityRule,
  getAgentReachabilityRule,
  type AgentReachabilityFacts,
} from "./peer-reachability.js";

const caller: AgentReachabilityFacts = { id: "caller", cwd: "/repo", labels: {} };

function target(overrides: Partial<AgentReachabilityFacts> = {}): AgentReachabilityFacts {
  return { id: "target", cwd: "/elsewhere", labels: {}, ...overrides };
}

describe("getAgentReachabilityRule", () => {
  it("allows the child relationship", () => {
    expect(
      getAgentReachabilityRule(
        caller,
        target({ id: "child", labels: { [PARENT_AGENT_ID_LABEL]: "caller" } }),
        true,
      ),
    ).toBe("child");
  });

  it("allows the parent relationship", () => {
    expect(
      getAgentReachabilityRule(
        { ...caller, labels: { [PARENT_AGENT_ID_LABEL]: "target" } },
        target(),
        true,
      ),
    ).toBe("parent");
  });

  it("allows the sibling relationship", () => {
    expect(
      getAgentReachabilityRule(
        { ...caller, labels: { [PARENT_AGENT_ID_LABEL]: "committee" } },
        target({ labels: { [PARENT_AGENT_ID_LABEL]: "committee" } }),
        true,
      ),
    ).toBe("sibling");
  });

  it("allows the cwd relationship", () => {
    expect(getAgentReachabilityRule(caller, target({ cwd: "/repo/nested" }), true)).toBe("cwd");
    expect(getAgentReachabilityRule(caller, target({ cwd: "/repo/nested" }), false)).toBeNull();
  });

  it("does not treat two parentless agents as siblings", () => {
    expect(getAgentReachabilityRule(caller, target(), true)).toBeNull();
    expect(getAgentReachabilityRule(caller, target(), false)).toBeNull();
  });

  it("only allows the target inside the caller cwd", () => {
    expect(getAgentReachabilityRule(caller, target({ cwd: "/repo/nested" }), true)).toBe("cwd");
    expect(
      getAgentReachabilityRule({ ...caller, cwd: "/repo/nested" }, target({ cwd: "/repo" }), true),
    ).toBeNull();
  });

  it.each([true, false])(
    "lineage rules are unaffected when cwdReachability=%s",
    (cwdReachability) => {
      expect(
        getAgentReachabilityRule(
          caller,
          target({
            id: "child",
            labels: { [PARENT_AGENT_ID_LABEL]: "caller" },
            cwd: "/repo/nested",
          }),
          cwdReachability,
        ),
      ).toBe("child");
    },
  );
});

describe("getAgentLineageReachabilityRule", () => {
  it("excludes cwd-only reachability", () => {
    expect(getAgentLineageReachabilityRule(caller, target({ cwd: "/repo/nested" }))).toBeNull();
  });
});
