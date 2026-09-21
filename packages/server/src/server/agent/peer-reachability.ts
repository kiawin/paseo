import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import { isSameOrDescendantPath } from "../path-utils.js";

export interface AgentReachabilityFacts {
  id: string;
  cwd: string;
  labels?: Record<string, string> | null;
}

export type AgentReachabilityRule = "parent" | "child" | "sibling" | "cwd";

export function getAgentReachabilityRule(
  caller: AgentReachabilityFacts,
  target: AgentReachabilityFacts,
): AgentReachabilityRule | null {
  const callerParentId = getParentAgentIdFromLabels(caller.labels);
  const targetParentId = getParentAgentIdFromLabels(target.labels);

  if (targetParentId === caller.id) return "child";
  if (callerParentId === target.id) return "parent";
  if (callerParentId !== null && callerParentId === targetParentId) return "sibling";
  if (isSameOrDescendantPath(caller.cwd, target.cwd)) return "cwd";
  return null;
}
