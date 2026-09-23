import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import { isSameOrDescendantPath } from "../path-utils.js";

export interface AgentReachabilityFacts {
  id: string;
  cwd: string;
  labels?: Record<string, string> | null;
}

export type AgentReachabilityRule = "parent" | "child" | "sibling" | "cwd";
export type AgentLineageReachabilityRule = Exclude<AgentReachabilityRule, "cwd">;

export function getAgentLineageReachabilityRule(
  caller: AgentReachabilityFacts,
  target: AgentReachabilityFacts,
): AgentLineageReachabilityRule | null {
  const callerParentId = getParentAgentIdFromLabels(caller.labels);
  const targetParentId = getParentAgentIdFromLabels(target.labels);

  if (targetParentId === caller.id) return "child";
  if (callerParentId === target.id) return "parent";
  if (callerParentId !== null && callerParentId === targetParentId) return "sibling";
  return null;
}

export function getAgentReachabilityRule(
  caller: AgentReachabilityFacts,
  target: AgentReachabilityFacts,
  cwdReachability: boolean,
): AgentReachabilityRule | null {
  const lineageRule = getAgentLineageReachabilityRule(caller, target);
  if (lineageRule !== null) return lineageRule;
  if (cwdReachability && isSameOrDescendantPath(caller.cwd, target.cwd)) return "cwd";
  return null;
}
