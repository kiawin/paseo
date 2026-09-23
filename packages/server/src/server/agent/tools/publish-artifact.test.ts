import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ArtifactStore } from "../../artifact-store.js";
import { NOTE_MAX_BYTES, NoteStore } from "../../note-store.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import type { PaseoToolCatalog } from "./types.js";

const AGENT_ID = "agt_one";
const WORKSPACE_ID = "wks_one";
const PROJECT_ID = "prj_one";

let root: string;
let store: ArtifactStore;
let noteStore: NoteStore;

function stubAgentManager(agent: unknown): AgentManager {
  return {
    getAgent: (id: string) => (id === AGENT_ID ? agent : undefined),
  } as unknown as AgentManager;
}

function stubWorkspaceRegistry(): Pick<WorkspaceRegistry, "get" | "list" | "upsert"> {
  return {
    get: async (workspaceId: string) =>
      workspaceId === WORKSPACE_ID
        ? ({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID } as never)
        : null,
    list: async () => [],
    upsert: async () => undefined,
  };
}

async function buildCatalog(
  overrides: { agent?: unknown; callerAgentId?: string } = {},
): Promise<PaseoToolCatalog> {
  const agent = overrides.agent ?? {
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    provider: "claude",
    cwd: "/repo",
  };
  return createPaseoToolCatalog({
    agentManager: stubAgentManager(agent),
    agentStorage: {} as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    workspaceRegistry: stubWorkspaceRegistry(),
    artifactStore: store,
    noteStore,
    callerAgentId: "callerAgentId" in overrides ? overrides.callerAgentId : AGENT_ID,
    logger: createTestLogger(),
  });
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "paseo-publish-artifact-"));
  store = new ArtifactStore(root, createTestLogger());
  await store.initialize();
  noteStore = new NoteStore(path.join(root, "notes"), createTestLogger());
  await noteStore.initialize();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("publish_artifact", () => {
  test("is in the catalog", async () => {
    const catalog = await buildCatalog();
    expect(catalog.getTool("publish_artifact")).toBeDefined();
  });

  test("resolves the caller's project and stores the document", async () => {
    const catalog = await buildCatalog();
    const result = await catalog.executeTool("publish_artifact", {
      title: "Q3 revenue dashboard",
      html: "<h1>Q3</h1>",
    });

    const output = result.structuredContent as { artifactId: string; title: string; size: number };
    expect(output.title).toBe("Q3 revenue dashboard");
    expect(output.size).toBe(11);

    const stored = await store.listForProject(PROJECT_ID);
    expect(stored).toHaveLength(1);
    const record = stored[0];
    if (!record) throw new Error("Expected the published artifact");
    expect(record.origin).toMatchObject({
      agentId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      provider: "claude",
    });
    expect(record.artifactId).toBe(output.artifactId);
    // By record, not id: the content path carries the digest.
    expect((await store.readContent(record)).toString()).toBe("<h1>Q3</h1>");
  });

  test("carries a companion link so a non-Claude agent can attach one", async () => {
    const catalog = await buildCatalog();
    const result = await catalog.executeTool("publish_artifact", {
      title: "Deployed report",
      html: "<p>x</p>",
      externalUrl: "https://reports.example.com/q3",
    });
    const { artifactId } = result.structuredContent as { artifactId: string };
    expect((await store.get(artifactId))?.externalUrl).toBe("https://reports.example.com/q3");
  });

  test("refuses a companion link that is not http or https", async () => {
    const catalog = await buildCatalog();
    await expect(
      catalog.executeTool("publish_artifact", {
        title: "Bad link",
        html: "<p/>",
        externalUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/http or https/);
  });

  test("records a link-only artifact when given a URL and no document", async () => {
    const catalog = await buildCatalog();
    const result = await catalog.executeTool("publish_artifact", {
      title: "Published on claude.ai",
      externalUrl: "https://claude.ai/code/artifact/abc",
    });

    const output = result.structuredContent as { artifactId: string; size: number | null };
    expect(output.size).toBeNull();
    const stored = await store.get(output.artifactId);
    expect(stored?.contentSha256).toBeNull();
    expect(stored?.externalUrl).toBe("https://claude.ai/code/artifact/abc");
  });

  test("refuses a title with neither a document nor a link", async () => {
    const catalog = await buildCatalog();
    await expect(catalog.executeTool("publish_artifact", { title: "Nothing" })).rejects.toThrow(
      /either a document or an external URL/,
    );
  });

  test("refuses when the caller agent has no workspace", async () => {
    const catalog = await buildCatalog({
      agent: { id: AGENT_ID, workspaceId: null, provider: "claude", cwd: "/repo" },
    });
    await expect(
      catalog.executeTool("publish_artifact", { title: "Orphan", html: "<p/>" }),
    ).rejects.toThrow(/no current workspace/);
  });

  test("refuses when there is no caller agent at all", async () => {
    const catalog = await buildCatalog({ callerAgentId: undefined });
    await expect(
      catalog.executeTool("publish_artifact", { title: "Anonymous", html: "<p/>" }),
    ).rejects.toThrow(/must be called by an agent/);
  });
});

describe("note tools", () => {
  test("registers list, read, and write tools", async () => {
    const catalog = await buildCatalog();

    expect(catalog.getTool("list_notes")).toBeDefined();
    expect(catalog.getTool("read_note")).toBeDefined();
    expect(catalog.getTool("write_note")).toBeDefined();
  });

  test("bounds list_notes to 50 by default and 200 at most, with metadata only", async () => {
    const catalog = await buildCatalog();
    for (let index = 0; index < 205; index += 1) {
      await noteStore.save({ projectId: PROJECT_ID, body: `# Note ${index}` });
    }

    const defaultResult = await catalog.executeTool("list_notes", {});
    const maxResult = await catalog.executeTool("list_notes", { limit: 200 });
    const defaultNotes = defaultResult.structuredContent as {
      notes: Array<Record<string, unknown>>;
    };
    const maxNotes = maxResult.structuredContent as { notes: Array<Record<string, unknown>> };

    expect(defaultNotes.notes).toHaveLength(50);
    expect(maxNotes.notes).toHaveLength(200);
    expect(defaultNotes.notes[0]).not.toHaveProperty("body");
  });

  test("read_note returns the whole body", async () => {
    const catalog = await buildCatalog();
    const body = "x".repeat(NOTE_MAX_BYTES);
    const saved = await noteStore.save({ projectId: PROJECT_ID, body });

    const result = await catalog.executeTool("read_note", { noteId: saved.record.noteId });
    const output = result.structuredContent as { body: string };

    expect(output.body).toBe(body);
  });

  test("write_note creates and updates notes with replacement reporting", async () => {
    const catalog = await buildCatalog();
    const created = await catalog.executeTool("write_note", { body: "# First version" });
    const createdOutput = created.structuredContent as {
      note: { noteId: string; revision: number };
      replacedRevision: number | null;
    };

    expect(createdOutput.note.revision).toBe(1);
    expect(createdOutput.replacedRevision).toBeNull();

    const updated = await catalog.executeTool("write_note", {
      noteId: createdOutput.note.noteId,
      body: "# Second version",
    });
    const updatedOutput = updated.structuredContent as {
      note: { noteId: string; revision: number };
      replacedRevision: number | null;
    };

    expect(updatedOutput.note).toMatchObject({ noteId: createdOutput.note.noteId, revision: 2 });
    expect(updatedOutput.replacedRevision).toBe(1);
  });

  test("rejects a decoded body over the 64 KiB cap", async () => {
    const catalog = await buildCatalog();

    await expect(
      catalog.executeTool("write_note", { body: "x".repeat(NOTE_MAX_BYTES + 1) }),
    ).rejects.toThrow(/64 KiB/);
    await expect(noteStore.listForProject(PROJECT_ID)).resolves.toHaveLength(0);
  });

  test("resolves the caller project and refuses a note from another project", async () => {
    const catalog = await buildCatalog();
    const own = await noteStore.save({ projectId: PROJECT_ID, body: "# Own" });
    const other = await noteStore.save({ projectId: "prj_other", body: "# Other" });

    const list = await catalog.executeTool("list_notes", { projectId: "prj_other" });
    const listed = list.structuredContent as {
      notes: Array<{ noteId: string; projectId: string }>;
    };
    expect(listed.notes).toHaveLength(1);
    expect(listed.notes[0]).toMatchObject({ noteId: own.record.noteId, projectId: PROJECT_ID });

    await expect(
      catalog.executeTool("write_note", {
        noteId: other.record.noteId,
        projectId: "prj_other",
        body: "# Hijacked",
      }),
    ).rejects.toThrow(/No note .* in project prj_one/);
    await expect(noteStore.readContent(other.record)).resolves.toEqual(
      Buffer.from("# Other", "utf8"),
    );
  });
});
