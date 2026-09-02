import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "./agent-sdk-types.js";

const logger = createTestLogger();
const WORKSPACE_ID = "wks_one";
const URL_TEXT = "https://claude.ai/code/artifact/abc";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class StubSession implements AgentSession {
  readonly provider = "claude" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  emit(item: AgentTimelineItem): void {
    for (const callback of this.subscribers) {
      callback({ type: "timeline", item, provider: this.provider });
    }
  }
}

class StubClient implements AgentClient {
  readonly provider = "claude" as const;
  readonly capabilities = CAPABILITIES;
  session: StubSession | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    this.session = new StubSession();
    return this.session;
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "opus", label: "Opus", isDefault: true }],
      modes: [],
    };
  }

  async resumeSession(): Promise<AgentSession> {
    this.session = new StubSession();
    return this.session;
  }
}

function artifactToolCall(overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "toolu_1",
    name: "Artifact",
    status: "completed",
    error: null,
    detail: { type: "artifact", url: URL_TEXT, title: "Q3 revenue" },
    ...overrides,
  } as AgentTimelineItem;
}

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const task of cleanup.splice(0).toReversed()) await task();
});

async function startAgent(options: { workspaceId?: string } = {}) {
  const published: unknown[] = [];
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-artifact-capture-"));
  const client = new StubClient();
  const manager = new AgentManager({
    clients: { claude: client },
    logger,
    onExternalArtifactPublished: (input) => published.push(input),
  });
  const agent = await manager.createAgent({ provider: "claude", cwd: workdir }, undefined, {
    workspaceId: "workspaceId" in options ? options.workspaceId : WORKSPACE_ID,
  });
  const run = manager.streamAgent(agent.id, "go");
  void (async () => {
    for await (const _event of run) {
      // Draining is what keeps the stream flowing; the assertions read `published`.
    }
  })();
  await manager.waitForAgentRunStart(agent.id);

  cleanup.push(async () => {
    await manager.closeAgent(agent.id).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  });
  return { manager, agent, client, published };
}

describe("external artifact capture from the timeline", () => {
  test("reports a completed artifact tool call, with the agent's workspace", async () => {
    const { client, agent, published } = await startAgent();
    client.session?.emit(artifactToolCall());
    await new Promise((resolve) => setImmediate(resolve));

    expect(published).toEqual([
      {
        agentId: agent.id,
        workspaceId: WORKSPACE_ID,
        provider: "claude",
        callId: "toolu_1",
        url: URL_TEXT,
        title: "Q3 revenue",
      },
    ]);
  });

  test.each(["running", "failed", "canceled"] as const)(
    "ignores a %s tool call — only a finished publish is a deliverable",
    async (status) => {
      const { client, published } = await startAgent();
      client.session?.emit(artifactToolCall({ status } as Partial<AgentTimelineItem>));
      await new Promise((resolve) => setImmediate(resolve));

      expect(published).toEqual([]);
    },
  );

  test("ignores every other tool detail", async () => {
    const { client, published } = await startAgent();
    client.session?.emit(
      artifactToolCall({
        detail: { type: "fetch", url: URL_TEXT },
      } as Partial<AgentTimelineItem>),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(published).toEqual([]);
  });

  test("reports a null title rather than inventing one", async () => {
    const { client, published } = await startAgent();
    client.session?.emit(
      artifactToolCall({
        detail: { type: "artifact", url: URL_TEXT },
      } as Partial<AgentTimelineItem>),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(published).toMatchObject([{ title: null }]);
  });

  test("stays silent for an agent with no workspace, which has no project to file under", async () => {
    const { client, published } = await startAgent({ workspaceId: undefined });
    client.session?.emit(artifactToolCall());
    await new Promise((resolve) => setImmediate(resolve));

    expect(published).toEqual([]);
  });
});
