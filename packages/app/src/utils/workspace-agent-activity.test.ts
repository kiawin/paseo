import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { buildWorkspaceAgentActivityIndex } from "./workspace-agent-activity";

function agent(input: {
  id: string;
  workspaceId?: string;
  status?: Agent["status"];
  updatedAt: string;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  attentionReason?: Agent["attentionReason"];
  pendingPermissionCount?: number;
  archivedAt?: string | null;
  parentAgentId?: string | null;
  title?: string | null;
}): Agent {
  return {
    serverId: "host-a",
    id: input.id,
    provider: "codex",
    status: input.status ?? "idle",
    activeTurn: input.status === "running" ? { turnId: "turn-1", startedAt: null } : null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(input.updatedAt),
    lastUserMessageAt: null,
    lastActivityAt: new Date(input.updatedAt),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: Array.from({ length: input.pendingPermissionCount ?? 0 }, (_, index) => ({
      id: `permission-${index}`,
      provider: "codex",
      name: "shell",
      kind: "tool",
      input: {},
    })),
    persistence: null,
    title: input.title ?? null,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    model: null,
    requiresAttention: input.requiresAttention,
    attentionReason: input.attentionReason,
    attentionTimestamp: input.attentionTimestamp ? new Date(input.attentionTimestamp) : null,
    archivedAt: input.archivedAt ? new Date(input.archivedAt) : null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
  };
}

describe("workspace agent activity index", () => {
  it("keeps the latest active root agent for each workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "older",
          agent({
            id: "older",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "permission",
          agent({
            id: "permission",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:01:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
        [
          "attention",
          agent({
            id: "attention",
            workspaceId: "workspace-b",
            updatedAt: "2026-06-01T10:00:00.000Z",
            attentionTimestamp: "2026-06-01T10:02:00.000Z",
            requiresAttention: true,
            attentionReason: "finished",
          }),
        ],
      ]),
    );

    expect(index).toEqual(
      new Map([
        [
          "workspace-a",
          {
            agentId: "permission",
            status: "needs_input",
            enteredAt: new Date("2026-06-01T10:01:00.000Z"),
            agents: [
              {
                agentId: "permission",
                title: null,
                status: "needs_input",
                enteredAt: new Date("2026-06-01T10:01:00.000Z"),
              },
              {
                agentId: "older",
                title: null,
                status: "running",
                enteredAt: new Date("2026-06-01T10:00:00.000Z"),
              },
            ],
          },
        ],
        [
          "workspace-b",
          {
            agentId: "attention",
            status: "attention",
            enteredAt: new Date("2026-06-01T10:02:00.000Z"),
            agents: [
              {
                agentId: "attention",
                title: null,
                status: "attention",
                enteredAt: new Date("2026-06-01T10:02:00.000Z"),
              },
            ],
          },
        ],
      ]),
    );
  });

  it("does not let archived or child agents change root workspace activity", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:03:00.000Z",
            pendingPermissionCount: 1,
            parentAgentId: "root",
          }),
        ],
        [
          "archived",
          agent({
            id: "archived",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:04:00.000Z",
            requiresAttention: true,
            attentionReason: "error",
            archivedAt: "2026-06-01T10:04:00.000Z",
          }),
        ],
      ]),
    );

    expect(index.get("workspace-a")).toEqual({
      agentId: "root",
      status: "running",
      enteredAt: new Date("2026-06-01T10:00:00.000Z"),
      agents: [
        {
          agentId: "root",
          title: null,
          status: "running",
          enteredAt: new Date("2026-06-01T10:00:00.000Z"),
        },
      ],
    });
  });

  it("treats a cross-workspace subagent as activity in its own workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "parent",
          agent({
            id: "parent",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "workspace-b",
            status: "running",
            updatedAt: "2026-06-01T10:03:00.000Z",
            parentAgentId: "parent",
          }),
        ],
      ]),
    );

    expect(index).toEqual(
      new Map([
        [
          "workspace-a",
          {
            agentId: "parent",
            status: "done",
            enteredAt: new Date("2026-06-01T10:00:00.000Z"),
            agents: [
              {
                agentId: "parent",
                title: null,
                status: "done",
                enteredAt: new Date("2026-06-01T10:00:00.000Z"),
              },
            ],
          },
        ],
        [
          "workspace-b",
          {
            agentId: "child",
            status: "running",
            enteredAt: new Date("2026-06-01T10:03:00.000Z"),
            agents: [
              {
                agentId: "child",
                title: null,
                status: "running",
                enteredAt: new Date("2026-06-01T10:03:00.000Z"),
              },
            ],
          },
        ],
      ]),
    );
  });

  it("preserves the activity index while the same agent remains in the same status", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:05:00.000Z",
          }),
        ],
      ]),
      previous,
    );

    expect(next).toBe(previous);
    expect(next.get("workspace-a")?.enteredAt).toEqual(new Date("2026-06-01T10:00:00.000Z"));
  });

  it("records a new entry time when an agent changes status", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "idle",
            updatedAt: "2026-06-01T10:05:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
      ]),
      previous,
    );

    expect(next).not.toBe(previous);
    expect(next.get("workspace-a")).toEqual({
      agentId: "root",
      status: "needs_input",
      enteredAt: new Date("2026-06-01T10:05:00.000Z"),
      agents: [
        {
          agentId: "root",
          title: null,
          status: "needs_input",
          enteredAt: new Date("2026-06-01T10:05:00.000Z"),
        },
      ],
    });
  });
  it("lists every active root agent in a workspace, most recently active first", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "middle",
          agent({
            id: "middle",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:01:00.000Z",
            title: "Port sidebar agent rows",
          }),
        ],
        [
          "oldest",
          agent({
            id: "oldest",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "newest",
          agent({
            id: "newest",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:02:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
      ]),
    );

    const activity = index.get("workspace-a");
    expect(activity?.agents.map((entry) => entry.agentId)).toEqual(["newest", "middle", "oldest"]);
    // The inlined fields are the head of the list, never a separate derivation.
    expect(activity?.agentId).toBe("newest");
    expect(activity?.status).toBe("needs_input");
    expect(activity?.agents[1]?.title).toBe("Port sidebar agent rows");
  });

  it("orders agents stamped in the same millisecond by id so rows do not swap", () => {
    const build = () =>
      buildWorkspaceAgentActivityIndex(
        new Map([
          [
            "b",
            agent({ id: "b", workspaceId: "workspace-a", updatedAt: "2026-06-01T10:00:00.000Z" }),
          ],
          [
            "a",
            agent({ id: "a", workspaceId: "workspace-a", updatedAt: "2026-06-01T10:00:00.000Z" }),
          ],
        ]),
      );

    expect(
      build()
        .get("workspace-a")
        ?.agents.map((entry) => entry.agentId),
    ).toEqual(["a", "b"]);
    expect(build().get("workspace-a")?.agentId).toBe("a");
  });

  it("keeps the agent list reference while every agent holds its status", () => {
    const agents = new Map([
      [
        "root",
        agent({
          id: "root",
          workspaceId: "workspace-a",
          status: "running",
          updatedAt: "2026-06-01T10:00:00.000Z",
        }),
      ],
      [
        "second",
        agent({
          id: "second",
          workspaceId: "workspace-a",
          status: "running",
          updatedAt: "2026-06-01T10:01:00.000Z",
        }),
      ],
    ]);
    const previous = buildWorkspaceAgentActivityIndex(agents);
    const next = buildWorkspaceAgentActivityIndex(agents, previous);

    expect(next).toBe(previous);
    expect(next.get("workspace-a")?.agents).toBe(previous.get("workspace-a")?.agents);
  });

  it("holds each agent's entry time when a sibling changes status", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "second",
          agent({
            id: "second",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:01:00.000Z",
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:09:00.000Z",
          }),
        ],
        [
          "second",
          agent({
            id: "second",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:10:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
      ]),
      previous,
    );

    const agentsById = new Map(
      next.get("workspace-a")?.agents.map((entry) => [entry.agentId, entry]) ?? [],
    );
    // "second" moved, so its clock restarts; "root" did not, so it keeps the original.
    expect(agentsById.get("second")?.status).toBe("needs_input");
    expect(agentsById.get("second")?.enteredAt).toEqual(new Date("2026-06-01T10:10:00.000Z"));
    expect(agentsById.get("root")?.enteredAt).toEqual(new Date("2026-06-01T10:00:00.000Z"));
    // The workspace row follows the head of the list, not the untouched agent.
    expect(next.get("workspace-a")?.enteredAt).toEqual(new Date("2026-06-01T10:10:00.000Z"));
  });

  it("rebuilds an entry when only the agent title changes", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
            title: null,
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
            title: "Rebase onto upstream main",
          }),
        ],
      ]),
      previous,
    );

    expect(next).not.toBe(previous);
    expect(next.get("workspace-a")?.agents[0]?.title).toBe("Rebase onto upstream main");
  });
});
