import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentSnapshotPayloadSchema,
  AgentTimelineItemPayloadSchema,
  ArchiveWorkspaceRequestSchema,
  ServerInfoStatusPayloadSchema,
  SessionOutboundMessageSchema,
  WorkspaceProjectDescriptorPayloadSchema,
  WorktreeLocationSchema,
  WSHelloMessageSchema,
} from "./messages.js";

const LegacySubAgentToolCallSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  error: z.unknown().nullable(),
  detail: z.object({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    log: z.string(),
    // Copied from v0.1.65-beta.3: actions was required even though the UI ignored it.
    actions: z.array(
      z.object({
        index: z.number().int().positive(),
        toolName: z.string(),
        summary: z.string().optional(),
      }),
    ),
  }),
});

const LegacyAgentCapabilityFlagsSchema = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
});

const LegacyAgentSnapshotPayloadSchema = AgentSnapshotPayloadSchema.extend({
  capabilities: LegacyAgentCapabilityFlagsSchema,
});

describe("wire schema compatibility", () => {
  test("hello parses with and without the project update capability", () => {
    const legacy = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "legacy-client",
      clientType: "mobile",
      protocolVersion: 1,
    });
    const capable = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "capable-client",
      clientType: "mobile",
      protocolVersion: 1,
      capabilities: { project_updates: true },
    });

    expect([legacy, capable]).toEqual([
      {
        type: "hello",
        clientId: "legacy-client",
        clientType: "mobile",
        protocolVersion: 1,
      },
      {
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { project_updates: true },
      },
    ]);
  });

  test("timeline replacement invalidation is opt-in and carries no timeline rows", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { timeline_replacement_invalidation: true },
      }).capabilities,
    ).toEqual({ timeline_replacement_invalidation: true });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.timeline.replacement",
        payload: { agentId: "agent-1", epoch: "epoch-2" },
      }),
    ).toEqual({
      type: "agent.timeline.replacement",
      payload: { agentId: "agent-1", epoch: "epoch-2" },
    });
  });

  test("server info strips unknown legacy features while accepting former turn identity", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "legacy-server",
      features: {
        workspaceGithubClone: true,
        agentTurnIdentity: true,
      },
    });

    expect(parsed).toEqual({
      status: "server_info",
      serverId: "legacy-server",
      hostname: null,
      version: null,
      features: { agentTurnIdentity: true },
    });
  });

  test("assistant timeline message ids are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "old daemon shape",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "old daemon shape",
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "new daemon shape",
        messageId: "msg-1",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "new daemon shape",
      messageId: "msg-1",
    });
  });

  test("task progress fields are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [{ text: "Legacy task", completed: false }],
      }),
    ).toEqual({ type: "todo", items: [{ text: "Legacy task", completed: false }] });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [
          {
            id: "task-1",
            text: "Current task",
            activeForm: "Working on current task",
            status: "in_progress",
            completed: false,
          },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        {
          id: "task-1",
          text: "Current task",
          activeForm: "Working on current task",
          status: "in_progress",
          completed: false,
        },
      ],
    });
  });

  test("sub_agent tool-call payload still parses against the v0.1.65-beta.3 schema", () => {
    const parsed = LegacySubAgentToolCallSchema.parse({
      type: "tool_call",
      callId: "call-sub-agent-1",
      name: "Task",
      status: "completed",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        childSessionId: "child-session-1",
        log: "[Read] README.md",
        actions: [],
      },
    });

    expect(parsed.detail.actions).toEqual([]);
  });

  test("old clients parse agent snapshots with rewind capabilities", () => {
    const parsed = LegacyAgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: true,
        supportsRewindFiles: true,
        supportsRewindBoth: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities).toEqual({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    });
  });

  test("new clients parse agent snapshots without rewind capabilities", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
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
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities.supportsRewindConversation).toBe(false);
    expect(parsed.capabilities.supportsRewindFiles).toBe(false);
    expect(parsed.capabilities.supportsRewindBoth).toBe(false);
  });

  // COMPAT(projectWorktreeLocation): added in v0.8.0, remove after 2027-09-02.
  test("archive request from an old client omits removeWorktreeDirectory", () => {
    const legacy = ArchiveWorkspaceRequestSchema.parse({
      type: "archive_workspace_request",
      workspaceId: "ws-1",
      requestId: "req-1",
    });

    // Absence must read as "leave the directory". A worktree cut outside
    // Paseo's managed root is only removed when a client explicitly asks, so
    // an old client that cannot ask gets the non-destructive path.
    expect(legacy.removeWorktreeDirectory).toBeUndefined();

    const explicit = ArchiveWorkspaceRequestSchema.parse({
      type: "archive_workspace_request",
      workspaceId: "ws-1",
      requestId: "req-1",
      removeWorktreeDirectory: true,
    });
    expect(explicit.removeWorktreeDirectory).toBe(true);
  });

  test("project descriptor parses with and without a worktree location", () => {
    const base = {
      projectId: "p-1",
      projectDisplayName: "repo",
      projectRootPath: "/home/u/repo",
      projectKind: "git" as const,
    };

    const legacy = WorkspaceProjectDescriptorPayloadSchema.parse(base);
    expect(legacy.projectWorktreeLocation).toBeUndefined();

    for (const mode of ["managed", "sibling", "nested"] as const) {
      const parsed = WorkspaceProjectDescriptorPayloadSchema.parse({
        ...base,
        projectWorktreeLocation: { mode },
      });
      expect(parsed.projectWorktreeLocation).toEqual({ mode });
    }

    const custom = WorkspaceProjectDescriptorPayloadSchema.parse({
      ...base,
      projectWorktreeLocation: { mode: "custom", root: "/home/u/worktrees" },
    });
    expect(custom.projectWorktreeLocation).toEqual({
      mode: "custom",
      root: "/home/u/worktrees",
    });

    // A daemon that predates the field sends null rather than omitting it.
    const nulled = WorkspaceProjectDescriptorPayloadSchema.parse({
      ...base,
      projectWorktreeLocation: null,
    });
    expect(nulled.projectWorktreeLocation).toBeNull();
  });

  test("custom worktree location requires a non-empty root", () => {
    expect(() => WorktreeLocationSchema.parse({ mode: "custom" })).toThrow();
    expect(() => WorktreeLocationSchema.parse({ mode: "custom", root: "" })).toThrow();
    expect(() => WorktreeLocationSchema.parse({ mode: "elsewhere" })).toThrow();
  });

  test("the worktree-location feature flag is optional in both directions", () => {
    const advertised = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-1",
      hostname: "host",
      version: "0.8.0",
      features: { projectWorktreeLocation: true },
    });
    expect(advertised.features?.projectWorktreeLocation).toBe(true);

    // An old daemon does not advertise it, so the client must read undefined
    // and gate the feature off rather than assuming support.
    const oldDaemon = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-1",
      hostname: "host",
      version: "0.7.0",
      features: {},
    });
    expect(oldDaemon.features?.projectWorktreeLocation).toBeUndefined();

    // An old client's schema predates the key entirely: parsing a new daemon's
    // payload must drop it rather than throw.
    const LegacyServerInfoSchema = z.object({
      status: z.literal("server_info"),
      serverId: z.string(),
      hostname: z.string(),
      version: z.string(),
      features: z.object({ providersSnapshot: z.boolean().optional() }).optional(),
    });
    const viaLegacy = LegacyServerInfoSchema.parse({
      status: "server_info",
      serverId: "srv-1",
      hostname: "host",
      version: "0.8.0",
      features: { providersSnapshot: true, projectWorktreeLocation: true },
    });
    expect(viaLegacy.features).toEqual({ providersSnapshot: true });
  });

  // Guards the rollout hazard recorded in the plan: zod strips unknown keys, so
  // a daemon predating a persisted field erases it on any re-parse. Deletion
  // policy must therefore never rely on a persisted field alone.
  test("zod strips unknown keys on re-parse", () => {
    const LegacyRecordSchema = z.object({
      workspaceId: z.string(),
      worktreeRoot: z.string().nullable().default(null),
    });

    const fromNewDaemon = {
      workspaceId: "ws-1",
      worktreeRoot: "/home/u/repo-worktrees/feat-x",
      worktreePlacement: "git-validated",
    };

    expect(LegacyRecordSchema.parse(fromNewDaemon)).toEqual({
      workspaceId: "ws-1",
      worktreeRoot: "/home/u/repo-worktrees/feat-x",
    });
  });
});
