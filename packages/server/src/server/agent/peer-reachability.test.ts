import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import { getAgentReachabilityRule, type AgentReachabilityFacts } from "./peer-reachability.js";

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
      ),
    ).toBe("child");
  });

  it("allows the parent relationship", () => {
    expect(
      getAgentReachabilityRule(
        { ...caller, labels: { [PARENT_AGENT_ID_LABEL]: "target" } },
        target(),
      ),
    ).toBe("parent");
  });

  it("allows the sibling relationship", () => {
    expect(
      getAgentReachabilityRule(
        { ...caller, labels: { [PARENT_AGENT_ID_LABEL]: "committee" } },
        target({ labels: { [PARENT_AGENT_ID_LABEL]: "committee" } }),
      ),
    ).toBe("sibling");
  });

  it("allows the cwd relationship", () => {
    expect(getAgentReachabilityRule(caller, target({ cwd: "/repo/nested" }))).toBe("cwd");
  });

  it("does not treat two parentless agents as siblings", () => {
    expect(getAgentReachabilityRule(caller, target())).toBeNull();
  });

  it("only allows the target inside the caller cwd", () => {
    expect(getAgentReachabilityRule(caller, target({ cwd: "/repo/nested" }))).toBe("cwd");
    expect(
      getAgentReachabilityRule({ ...caller, cwd: "/repo/nested" }, target({ cwd: "/repo" })),
    ).toBeNull();
  });
});
