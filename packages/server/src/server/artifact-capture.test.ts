import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { ArtifactStore } from "./artifact-store.js";
import { createExternalArtifactRecorder } from "./artifact-capture.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

const AGENT_ID = "agt_one";
const WORKSPACE_ID = "wks_one";
const PROJECT_ID = "prj_one";
const URL_TEXT = "https://claude.ai/code/artifact/abc";

let root: string;
let store: ArtifactStore;

function registry(known = true): Pick<WorkspaceRegistry, "get"> {
  return {
    get: async (workspaceId: string) =>
      known && workspaceId === WORKSPACE_ID
        ? ({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID } as never)
        : null,
  };
}

function recorder(workspaceRegistry = registry()) {
  return createExternalArtifactRecorder({
    artifactStore: store,
    workspaceRegistry,
    logger: createTestLogger(),
  });
}

function publication(overrides: Partial<Parameters<ReturnType<typeof recorder>>[0]> = {}) {
  return {
    agentId: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    provider: "claude",
    callId: "toolu_1",
    url: URL_TEXT,
    title: "Q3 revenue dashboard",
    ...overrides,
  };
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "paseo-artifact-capture-"));
  store = new ArtifactStore(root, createTestLogger());
  await store.initialize();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("external artifact capture", () => {
  test("files the publication as a link, never a stored copy", async () => {
    await recorder()(publication());

    const [record] = await store.listForProject(PROJECT_ID);
    expect(record?.title).toBe("Q3 revenue dashboard");
    expect(record?.externalUrl).toBe(URL_TEXT);
    // The whole point: a published page can depend on its own origin, so Paseo holds no bytes.
    expect(record?.contentSha256).toBeNull();
    expect(record?.size).toBeNull();
    expect(record?.origin).toMatchObject({
      agentId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      provider: "claude",
      callId: "toolu_1",
    });
  });

  test("a replayed tool result does not add a second row", async () => {
    const record = recorder();
    await record(publication());
    await record(publication());

    expect(await store.listForProject(PROJECT_ID)).toHaveLength(1);
  });

  test("distinct calls from one agent are distinct artifacts", async () => {
    const record = recorder();
    await record(publication({ callId: "toolu_1" }));
    await record(publication({ callId: "toolu_2", title: "Second" }));

    expect(await store.listForProject(PROJECT_ID)).toHaveLength(2);
  });

  test("falls back to the host when the tool reported no title", async () => {
    await recorder()(publication({ title: null }));

    expect((await store.listForProject(PROJECT_ID))[0]?.title).toBe("claude.ai");
  });

  test("files nothing when the reported URL is malformed", async () => {
    await recorder()(publication({ title: "   ", url: "https://" }));

    expect(await store.listForProject(PROJECT_ID)).toEqual([]);
  });

  test("refuses a non-http destination outright", async () => {
    await recorder()(publication({ url: "javascript:alert(1)" }));

    expect(await store.listForProject(PROJECT_ID)).toEqual([]);
  });

  test("files nothing when the workspace is unknown", async () => {
    await recorder(registry(false))(publication());

    expect(await store.listForProject(PROJECT_ID)).toEqual([]);
  });

  test("swallows a store failure — the turn already succeeded and is not waiting", async () => {
    const failing = createExternalArtifactRecorder({
      artifactStore: {
        publish: async () => {
          throw new Error("disk full");
        },
      },
      workspaceRegistry: registry(),
      logger: createTestLogger(),
    });

    await expect(failing(publication())).resolves.toBeUndefined();
  });
});
