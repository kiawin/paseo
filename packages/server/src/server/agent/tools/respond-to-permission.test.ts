import { describe, expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

interface AgentStub {
  id: string;
  cwd: string;
  labels?: Record<string, string>;
}

const target: AgentStub = { id: "target", cwd: "/repo/target", labels: {} };
const parent: AgentStub = { id: "parent", cwd: "/repo/parent", labels: {} };
const child: AgentStub = {
  id: "child",
  cwd: "/repo/child",
  labels: { [PARENT_AGENT_ID_LABEL]: "target" },
};
const sibling: AgentStub = {
  id: "sibling",
  cwd: "/repo/sibling",
  labels: { [PARENT_AGENT_ID_LABEL]: "shared-parent" },
};
const unrelated: AgentStub = { id: "unrelated", cwd: "/elsewhere", labels: {} };

function buildCatalog(callerAgentId: string | undefined, agents: AgentStub[]) {
  const respondToPermission = vi.fn().mockResolvedValue(undefined);
  const agentManager = {
    getAgent: (id: string) => agents.find((agent) => agent.id === id) ?? null,
    respondToPermission,
  } as unknown as AgentManager;

  const catalog = createPaseoToolCatalog({
    agentManager,
    agentStorage: {} as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    callerAgentId,
    logger: createTestLogger(),
  });
  return { catalog, respondToPermission };
}

async function answer(callerAgentId: string | undefined, agents: AgentStub[]) {
  const { catalog, respondToPermission } = buildCatalog(callerAgentId, agents);
  const result = await catalog
    .executeTool("respond_to_permission", {
      agentId: target.id,
      requestId: "permission",
      response: { behavior: "allow" },
    })
    .then(() => ({ ok: true, respondToPermission }))
    .catch((error: unknown) => ({ ok: false, error, respondToPermission }));
  return result;
}

describe("respond_to_permission authorization", () => {
  test.each([
    ["parent", parent, { ...target, labels: { [PARENT_AGENT_ID_LABEL]: "parent" } }],
    ["child", child, target],
    ["sibling", sibling, { ...target, labels: { [PARENT_AGENT_ID_LABEL]: "shared-parent" } }],
  ])(
    "allows a %s to answer the target's provider permission",
    async (_name, caller, targetAgent) => {
      const result = await answer(caller.id, [caller, targetAgent]);
      expect(result.ok).toBe(true);
      expect(result.respondToPermission).toHaveBeenCalledOnce();
    },
  );

  test("refuses an unrelated agent before calling the provider", async () => {
    const result = await answer(unrelated.id, [unrelated, target]);
    expect(result.ok).toBe(false);
    expect(result.error).toEqual(
      new Error(
        "You must be in the target agent's lineage to answer its provider permission; let the user answer it instead.",
      ),
    );
    expect(result.respondToPermission).not.toHaveBeenCalled();
  });

  test("refuses an agent that only shares a cwd subtree", async () => {
    const cwdPeer = { ...unrelated, cwd: "/repo" };
    const cwdTarget = { ...target, cwd: "/repo/nested" };
    const result = await answer(cwdPeer.id, [cwdPeer, cwdTarget]);
    expect(result.ok).toBe(false);
    expect(result.error).toEqual(
      new Error(
        "You must be in the target agent's lineage to answer its provider permission; let the user answer it instead.",
      ),
    );
    expect(result.respondToPermission).not.toHaveBeenCalled();
  });

  test("allows the top-level user to answer any provider permission", async () => {
    const result = await answer(undefined, [target]);
    expect(result.ok).toBe(true);
    expect(result.respondToPermission).toHaveBeenCalledOnce();
  });
});
