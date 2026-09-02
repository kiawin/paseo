import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { ARTIFACT_MAX_BYTES, ArtifactStore } from "./artifact-store.js";
import { createExternalArtifactRecorder } from "./artifact-capture.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

const AGENT_ID = "agt_one";
const WORKSPACE_ID = "wks_one";
const PROJECT_ID = "prj_one";
const URL_TEXT = "https://claude.ai/code/artifact/abc";
const OTHER_URL_TEXT = "https://claude.ai/code/artifact/def";

const DOCUMENT =
  "<!doctype html><html><head><title>Q3 revenue — the whole picture</title></head>" +
  "<body>numbers</body></html>";

let root: string;
let scratch: string;
let store: ArtifactStore;

/** Writes what the agent handed the publishing tool, outside the store's own root. */
function published(contents: string, name = "report.html"): string {
  const target = path.join(scratch, name);
  writeFileSync(target, contents);
  return target;
}

function registry(known = true): Pick<WorkspaceRegistry, "get"> {
  return {
    get: async (workspaceId: string) =>
      known && workspaceId === WORKSPACE_ID
        ? ({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, cwd: scratch } as never)
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
  scratch = mkdtempSync(path.join(os.tmpdir(), "paseo-artifact-scratch-"));
  store = new ArtifactStore(root, createTestLogger());
  await store.initialize();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("external artifact capture", () => {
  test("files the publication as a copy that keeps its address", async () => {
    await recorder()(publication({ filePath: published(DOCUMENT) }));

    const record = (await store.listForProject(PROJECT_ID))[0];
    if (!record) throw new Error("nothing was filed");
    expect(record.title).toBe("Q3 revenue — the whole picture");
    // Both: the copy is what Paseo can open anywhere, the address is the page that still works.
    expect(record.externalUrl).toBe(URL_TEXT);
    expect(record.size).toBe(Buffer.byteLength(DOCUMENT));
    expect((await store.readContent(record)).toString("utf8")).toBe(DOCUMENT);
    expect(record.origin).toMatchObject({
      agentId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      provider: "claude",
      callId: "toolu_1",
    });
  });

  test("the document's own title outranks the name the tool reported", async () => {
    await recorder()(publication({ title: "report", filePath: published(DOCUMENT) }));

    expect((await store.listForProject(PROJECT_ID))[0]?.title).toBe(
      "Q3 revenue — the whole picture",
    );
  });

  test("resolves entities and collapses whitespace in a title", async () => {
    const html = "<html><head><title>\n  Q3 &amp; Q4 &#x2014;\n  final\n</title></head></html>";
    await recorder()(publication({ filePath: published(html) }));

    expect((await store.listForProject(PROJECT_ID))[0]?.title).toBe("Q3 & Q4 — final");
  });

  test("a title past the first 8 KB is not the artifact's name", async () => {
    const html = `<html><head>${"<!-- pad -->".repeat(900)}<title>Buried</title></head></html>`;
    await recorder()(publication({ title: "Reported", filePath: published(html) }));

    // claude.ai stops looking at 8 KB too, so both name the page the same way.
    expect((await store.listForProject(PROJECT_ID))[0]?.title).toBe("Reported");
  });

  test("a relative path is read against the agent's workspace, not the daemon's cwd", async () => {
    // An agent that writes into its own working directory reports the path it was handed.
    published(DOCUMENT, "relative.html");
    await recorder()(publication({ filePath: "relative.html" }));

    const record = (await store.listForProject(PROJECT_ID))[0];
    if (!record) throw new Error("nothing was filed");
    expect(record.contentSha256).not.toBeNull();
    expect((await store.readContent(record)).toString("utf8")).toBe(DOCUMENT);
  });

  test("keeps the link alone when the published file is gone", async () => {
    await recorder()(publication({ filePath: path.join(scratch, "swept-away.html") }));

    const record = (await store.listForProject(PROJECT_ID))[0];
    expect(record?.title).toBe("Q3 revenue dashboard");
    expect(record?.externalUrl).toBe(URL_TEXT);
    expect(record?.contentSha256).toBeNull();
  });

  test("a markdown publish is a link, not a stored document", async () => {
    // A record claims `text/html`; storing markdown under it would render source as a page.
    await recorder()(publication({ filePath: published("# Report", "report.md") }));

    expect((await store.listForProject(PROJECT_ID))[0]?.contentSha256).toBeNull();
  });

  test("a document over the size cap is a link rather than a failed capture", async () => {
    const oversized = `<title>Huge</title>${"x".repeat(ARTIFACT_MAX_BYTES)}`;
    await recorder()(publication({ filePath: published(oversized, "huge.html") }));

    const record = (await store.listForProject(PROJECT_ID))[0];
    expect(record?.externalUrl).toBe(URL_TEXT);
    expect(record?.contentSha256).toBeNull();
  });

  test("a replay after the scratch file is gone keeps the copy", async () => {
    const file = published(DOCUMENT);
    const record = recorder();
    await record(publication({ filePath: file }));
    const stored = (await store.listForProject(PROJECT_ID))[0];
    rmSync(file);

    await record(publication({ filePath: file }));

    const rows = await store.listForProject(PROJECT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contentSha256).toBe(stored?.contentSha256);
  });

  test("an edit that cannot read its file keeps the copy and takes the new title", async () => {
    const file = published(DOCUMENT);
    const record = recorder();
    await record(publication({ callId: "toolu_1", filePath: file }));
    rmSync(file);

    await record(publication({ callId: "toolu_2", title: "Final", filePath: file }));

    const rows = await store.listForProject(PROJECT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Final");
    expect(rows[0]?.size).toBe(Buffer.byteLength(DOCUMENT));
  });

  test("an edit replaces the copy with the document it published", async () => {
    const record = recorder();
    await record(publication({ callId: "toolu_1", filePath: published(DOCUMENT) }));
    const edited = "<html><head><title>Q3 revenue — revised</title></head><body>v2</body></html>";
    await record(publication({ callId: "toolu_2", filePath: published(edited, "revised.html") }));

    const rows = await store.listForProject(PROJECT_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("nothing was filed");
    expect(row.title).toBe("Q3 revenue — revised");
    expect((await store.readContent(row)).toString("utf8")).toBe(edited);
  });

  test("a replayed tool result does not add a second row", async () => {
    const record = recorder();
    await record(publication());
    await record(publication());

    expect(await store.listForProject(PROJECT_ID)).toHaveLength(1);
  });

  test("distinct calls to distinct URLs are distinct artifacts", async () => {
    const record = recorder();
    await record(publication({ callId: "toolu_1", url: URL_TEXT }));
    await record(publication({ callId: "toolu_2", url: OTHER_URL_TEXT, title: "Second" }));

    expect(await store.listForProject(PROJECT_ID)).toHaveLength(2);
  });

  test("a Claude edit re-publishes under the same URL and refreshes the one row", async () => {
    const record = recorder();
    await record(publication({ callId: "toolu_1" }));
    await record(publication({ callId: "toolu_2", title: "Final" }));

    const rows = await store.listForProject(PROJECT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Final");
    expect(rows[0]?.externalUrl).toBe(URL_TEXT);
    expect(rows[0]?.origin).toMatchObject({ agentId: AGENT_ID, callId: "toolu_2" });
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
