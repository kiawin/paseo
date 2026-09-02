import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { ArtifactError, ArtifactStore, ARTIFACT_MAX_BYTES } from "./artifact-store.js";

const AGENT = { agentId: "agt_one", workspaceId: "wks_one", provider: "claude" };
const OTHER_AGENT = { agentId: "agt_two", workspaceId: "wks_two", provider: "codex" };

let root: string;
let store: ArtifactStore;

async function open(): Promise<ArtifactStore> {
  const next = new ArtifactStore(root, createTestLogger());
  await next.initialize();
  return next;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "paseo-artifacts-"));
  store = await open();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("publish", () => {
  test("stores the document beside the index and reads it back", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "  Q3   revenue  ",
      html: "<h1>hi</h1>",
      origin: AGENT,
    });

    expect(record.artifactId).toMatch(/^art_[0-9a-f]{16}$/);
    expect(record.title).toBe("Q3 revenue");
    expect(record.mimeType).toBe("text/html");
    expect(record.size).toBe(11);
    expect(record.externalUrl).toBeNull();
    expect((await store.readContent(record)).toString()).toBe("<h1>hi</h1>");
    expect(store.contentPath(record)).toBe(
      path.join(root, "prj_a", `${record.artifactId}.${record.contentSha256}.html`),
    );
  });

  test("survives a reopen", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Report",
      html: "<p>x</p>",
      origin: AGENT,
    });
    const reopened = await open();
    expect(await reopened.listForProject("prj_a")).toEqual([record]);
  });

  test("lists only the requested project, newest first", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "One",
      html: "<p>1</p>",
      origin: AGENT,
    });
    const second = await store.publish({
      projectId: "prj_a",
      title: "Two",
      html: "<p>2</p>",
      origin: AGENT,
    });
    await store.publish({ projectId: "prj_b", title: "Other", html: "<p>3</p>", origin: AGENT });

    const listed = await store.listForProject("prj_a");
    expect(listed.map((record) => record.title)).toEqual(["Two", "One"]);
    expect(listed.map((record) => record.artifactId)).toEqual([
      second.record.artifactId,
      first.record.artifactId,
    ]);
  });

  test("rejects a document over the size cap before writing anything", async () => {
    await expect(
      store.publish({
        projectId: "prj_a",
        title: "Huge",
        html: "x".repeat(ARTIFACT_MAX_BYTES + 1),
        origin: AGENT,
      }),
    ).rejects.toMatchObject({ code: "artifact_too_large" });
    expect(await store.listForProject("prj_a")).toEqual([]);
    await expect(fs.readdir(path.join(root, "prj_a"))).rejects.toThrow();
  });

  test("rejects an empty title", async () => {
    await expect(
      store.publish({ projectId: "prj_a", title: "   ", html: "<p/>", origin: AGENT }),
    ).rejects.toMatchObject({ code: "artifact_invalid_title" });
  });

  test.each(["javascript:alert(1)", "file:///etc/passwd", "not a url"])(
    "rejects %s as a companion link",
    async (externalUrl) => {
      await expect(
        store.publish({
          projectId: "prj_a",
          title: "Linked",
          html: "<p/>",
          externalUrl,
          origin: AGENT,
        }),
      ).rejects.toMatchObject({ code: "artifact_invalid_external_url" });
    },
  );

  test("keeps a normalized https companion link", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Linked",
      html: "<p/>",
      externalUrl: "https://claude.ai/public/artifacts/abc",
      origin: AGENT,
    });
    expect(record.externalUrl).toBe("https://claude.ai/public/artifacts/abc");
  });

  test("accepts legacy remote-shaped and path-shaped project ids on every platform", async () => {
    for (const projectId of ["remote:github.com/acme/project", "/legacy/path/project"]) {
      const { record } = await store.publish({
        projectId,
        title: "Legacy project",
        html: "<p>kept</p>",
        origin: AGENT,
      });

      expect(await store.listForProject(projectId)).toEqual([record]);
      await expect(fs.access(store.contentPath(record))).resolves.toBeUndefined();
    }
  });

  test("rejects dot path segments using either separator on every platform", async () => {
    for (const projectId of [".", "..", "a/./b", "a/../b", "a\\.\\b", "a\\..\\b"]) {
      await expect(
        store.publish({ projectId, title: "Doc", html: "<p>x</p>", origin: AGENT }),
      ).rejects.toMatchObject({ code: "artifact_invalid_project" });
    }
    expect(await store.listForProject(".")).toEqual([]);
    expect(await store.listForProject("..")).toEqual([]);
  });
});

describe("search", () => {
  test("matches titles and visible document text within one project", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Unclear report",
      html: `<!doctype html><html><head><title>Hidden heading</title>
        <style>.secret { color: red }</style><script>const token = "invisible";</script></head>
        <body><h1>Quarterly results</h1><p>Visitor conversion rose with coffee &amp; tea.</p></body></html>`,
      origin: AGENT,
    });
    const link = await store.publish({
      projectId: "prj_a",
      title: "External dashboard",
      externalUrl: "https://example.com/dashboard",
      origin: AGENT,
    });
    await store.publish({
      projectId: "prj_b",
      title: "Other project",
      html: "<p>Visitor conversion</p>",
      origin: AGENT,
    });

    expect(await store.searchForProject("prj_a", "REPORT")).toEqual([
      { artifactId: record.artifactId, snippet: null },
    ]);
    expect(await store.searchForProject("prj_a", "  visitor COFFEE ")).toEqual([
      { artifactId: record.artifactId, snippet: expect.stringContaining("coffee & tea") },
    ]);
    expect(await store.searchForProject("prj_a", "report conversion")).toEqual([
      { artifactId: record.artifactId, snippet: expect.stringContaining("conversion") },
    ]);
    expect(await store.searchForProject("prj_a", "dashboard")).toEqual([
      { artifactId: link.record.artifactId, snippet: null },
    ]);
    expect(await store.searchForProject("prj_a", "invisible")).toEqual([]);
    expect(await store.searchForProject("prj_a", "secret")).toEqual([]);
    expect(await store.searchForProject("prj_a", "hidden heading")).toEqual([]);
    expect(await store.searchForProject("prj_a", "other project")).toEqual([]);
    expect(await store.searchForProject("prj_a", "   ")).toEqual([]);
  });

  test("uses the new document after an overwrite and can search records after restart", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "Report",
      html: "<p>oranges</p>",
      origin: AGENT,
    });
    expect(await store.searchForProject("prj_a", "oranges")).toHaveLength(1);

    await store.publish({
      projectId: "prj_a",
      title: "Report",
      html: "<p>apples</p>",
      artifactId: first.record.artifactId,
      origin: AGENT,
    });
    expect(await store.searchForProject("prj_a", "oranges")).toEqual([]);
    expect(await (await open()).searchForProject("prj_a", "apples")).toEqual([
      { artifactId: first.record.artifactId, snippet: "apples" },
    ]);
  });
});

describe("rename", () => {
  test("keeps a user title through agent republish, reload, and reset", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "Unclear title",
      html: "<p>Contents</p>",
      origin: AGENT,
    });
    const renamed = await store.setCustomTitle(first.record.artifactId, "  Team   report  ");
    expect(renamed).toMatchObject({
      title: "Unclear title",
      customTitle: "Team report",
      updatedAt: first.record.updatedAt,
    });
    expect((await (await open()).listForProject("prj_a"))[0]?.customTitle).toBe("Team report");

    const republished = await store.publish({
      projectId: "prj_a",
      artifactId: first.record.artifactId,
      title: "Agent's new title",
      html: "<p>Updated contents</p>",
      origin: AGENT,
    });
    expect(republished.record.title).toBe("Agent's new title");
    expect(republished.record.customTitle).toBe("Team report");
    expect(await store.searchForProject("prj_a", "team")).toHaveLength(1);
    expect(await store.searchForProject("prj_a", "agent's new")).toHaveLength(1);

    const reset = await store.setCustomTitle(first.record.artifactId, null);
    expect(reset?.customTitle).toBeUndefined();
    expect(reset?.updatedAt).toBe(republished.record.updatedAt);
    expect((await (await open()).listForProject("prj_a"))[0]?.customTitle).toBeUndefined();
    expect(await store.searchForProject("prj_a", "team")).toEqual([]);
  });

  test("renames a link-only artifact and rejects a blank user title", async () => {
    const link = await store.publish({
      projectId: "prj_a",
      title: "Published on claude.ai",
      externalUrl: "https://claude.ai/code/artifact/example",
      origin: AGENT,
    });
    await expect(store.setCustomTitle(link.record.artifactId, "   ")).rejects.toMatchObject({
      code: "artifact_invalid_title",
    });
    const renamed = await store.setCustomTitle(link.record.artifactId, "Facilities plan");
    expect(renamed?.customTitle).toBe("Facilities plan");
    expect(renamed?.contentSha256).toBeNull();
    expect((await store.listForProject("prj_a"))[0]?.customTitle).toBe("Facilities plan");
  });
});

describe("overwrite", () => {
  test("replaces content and keeps createdAt and the id", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "Draft",
      html: "<p>v1</p>",
      origin: AGENT,
    });
    const second = await store.publish({
      projectId: "prj_a",
      title: "Final",
      html: "<p>v2</p>",
      artifactId: first.record.artifactId,
      origin: AGENT,
    });

    expect(second.record.artifactId).toBe(first.record.artifactId);
    expect(second.record.createdAt).toBe(first.record.createdAt);
    expect(second.record.title).toBe("Final");
    expect((await store.readContent(second.record)).toString()).toBe("<p>v2</p>");
    expect(await store.listForProject("prj_a")).toHaveLength(1);
    // The superseded version is unlinked once the index no longer names it.
    await expect(fs.access(store.contentPath(first.record) as string)).rejects.toThrow();
  });

  test("refuses a sibling agent's artifact", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Mine",
      html: "<p>v1</p>",
      origin: AGENT,
    });

    await expect(
      store.publish({
        projectId: "prj_a",
        title: "Hijacked",
        html: "<p>evil</p>",
        artifactId: record.artifactId,
        origin: OTHER_AGENT,
      }),
    ).rejects.toMatchObject({ code: "artifact_forbidden" });
    expect((await store.readContent(record)).toString()).toBe("<p>v1</p>");
  });

  test("refuses an unknown artifact id", async () => {
    await expect(
      store.publish({
        projectId: "prj_a",
        title: "Ghost",
        html: "<p/>",
        artifactId: "art_missing",
        origin: AGENT,
      }),
    ).rejects.toMatchObject({ code: "artifact_not_found" });
  });

  test("a replayed tool result resolves to the record it already produced", async () => {
    const origin = { ...AGENT, callId: "toolu_1" };
    const first = await store.publish({
      projectId: "prj_a",
      title: "Dashboard",
      html: "<p>v1</p>",
      origin,
    });
    const replay = await store.publish({
      projectId: "prj_a",
      title: "Dashboard",
      html: "<p>v1</p>",
      origin,
    });

    expect(replay.record.artifactId).toBe(first.record.artifactId);
    expect(await store.listForProject("prj_a")).toHaveLength(1);
  });

  test("the same call id from a different agent is a different artifact", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "A",
      html: "<p/>",
      origin: { ...AGENT, callId: "toolu_1" },
    });
    const second = await store.publish({
      projectId: "prj_a",
      title: "B",
      html: "<p/>",
      origin: { ...OTHER_AGENT, callId: "toolu_1" },
    });
    expect(second.record.artifactId).not.toBe(first.record.artifactId);
  });

  test("a link publication to an already-listed URL updates that record", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "Draft",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_1" },
    });
    await store.setCustomTitle(first.record.artifactId, "My useful report");
    const second = await store.publish({
      projectId: "prj_a",
      title: "Final",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_2" },
    });

    expect(second.record.artifactId).toBe(first.record.artifactId);
    expect(second.record.title).toBe("Final");
    expect(second.record.customTitle).toBe("My useful report");
    expect(second.record.createdAt).toBe(first.record.createdAt);
    expect(second.record.updatedAt >= first.record.updatedAt).toBe(true);
    expect(second.record.origin.callId).toBe("toolu_2");
    expect(await store.listForProject("prj_a")).toHaveLength(1);
  });

  test("a document published on purpose is not collapsed into a captured row", async () => {
    await store.publish({
      projectId: "prj_a",
      title: "Captured",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_1" },
    });
    await store.publish({
      projectId: "prj_a",
      title: "Stored",
      html: "<p>v1</p>",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: AGENT,
    });

    // No callId, so this is `publish_artifact` and not a capture. A URL scraped from tool-result
    // text never gets to unlink a document an agent published deliberately.
    expect(await store.listForProject("prj_a")).toHaveLength(2);
  });

  test("a capture does not collapse into a document published on purpose", async () => {
    const document = await store.publish({
      projectId: "prj_a",
      title: "Stored",
      html: "<p>v1</p>",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: AGENT,
    });
    await store.publish({
      projectId: "prj_a",
      title: "Captured",
      html: "<p>snapshot</p>",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_1" },
    });

    expect(await store.listForProject("prj_a")).toHaveLength(2);
    expect((await store.readContent(document.record)).toString("utf8")).toBe("<p>v1</p>");
  });

  test("a captured edit replaces the copy on the row it already filed", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "Draft",
      html: "<p>v1</p>",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_1" },
    });
    await store.setCustomTitle(first.record.artifactId, "Saved report name");
    const second = await store.publish({
      projectId: "prj_a",
      title: "Final",
      html: "<p>v2</p>",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_2" },
    });

    expect(second.record.artifactId).toBe(first.record.artifactId);
    expect(second.record.customTitle).toBe("Saved report name");
    expect(await store.listForProject("prj_a")).toHaveLength(1);
    expect((await store.readContent(second.record)).toString("utf8")).toBe("<p>v2</p>");
  });

  test("keepExistingContent leaves the stored document alone when a re-file has none", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "Draft",
      html: "<p>v1</p>",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_1" },
    });
    const second = await store.publish({
      projectId: "prj_a",
      title: "Final",
      keepExistingContent: true,
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_2" },
    });

    expect(second.record.title).toBe("Final");
    expect(second.record.contentSha256).toBe(first.record.contentSha256);
    expect(second.record.size).toBe(first.record.size);
    expect((await store.readContent(second.record)).toString("utf8")).toBe("<p>v1</p>");
  });

  test("without it, a publication carrying no document turns the row back into a link", async () => {
    await store.publish({
      projectId: "prj_a",
      title: "Draft",
      html: "<p>v1</p>",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_1" },
    });
    const second = await store.publish({
      projectId: "prj_a",
      title: "Final",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: { ...AGENT, callId: "toolu_2" },
    });

    expect(second.record.contentSha256).toBeNull();
    expect(second.record.size).toBeNull();
  });

  test("the same URL in two projects is two artifacts", async () => {
    await store.publish({
      projectId: "prj_a",
      title: "A",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: AGENT,
    });
    await store.publish({
      projectId: "prj_b",
      title: "B",
      externalUrl: "https://claude.ai/code/artifact/abc",
      origin: AGENT,
    });

    expect(await store.listForProject("prj_a")).toHaveLength(1);
    expect(await store.listForProject("prj_b")).toHaveLength(1);
  });
});

describe("eviction", () => {
  async function publish(target: ArtifactStore, title: string, bytes: number) {
    const { record } = await target.publish({
      projectId: "prj_a",
      title,
      html: "x".repeat(bytes),
      origin: AGENT,
    });
    return record;
  }

  test("evicts oldest-first by updatedAt once the count cap binds", async () => {
    const capped = new ArtifactStore(root, createTestLogger(), { maxPerProject: 3 });
    await capped.initialize();

    const first = await publish(capped, "One", 8);
    const second = await publish(capped, "Two", 8);
    await publish(capped, "Three", 8);
    await publish(capped, "Four", 8);

    const listed = await capped.listForProject("prj_a");
    expect(listed.map((record) => record.title)).toEqual(["Four", "Three", "Two"]);
    await expect(fs.access(capped.contentPath(first) as string)).rejects.toThrow();
    expect(second.artifactId).toBe(listed[2]?.artifactId);
  });

  test("an overwrite refreshes updatedAt, so the record leaves the firing line", async () => {
    const capped = new ArtifactStore(root, createTestLogger(), { maxPerProject: 3 });
    await capped.initialize();

    const first = await publish(capped, "One", 8);
    const second = await publish(capped, "Two", 8);
    await publish(capped, "Three", 8);
    await capped.publish({
      projectId: "prj_a",
      title: "One again",
      html: "<p/>",
      artifactId: first.artifactId,
      origin: AGENT,
    });
    await publish(capped, "Four", 8);

    const listed = await capped.listForProject("prj_a");
    expect(listed.map((record) => record.title)).toEqual(["Four", "One again", "Three"]);
    await expect(fs.access(capped.contentPath(second) as string)).rejects.toThrow();
  });

  test("evicts on the byte cap as well as the count cap", async () => {
    const capped = new ArtifactStore(root, createTestLogger(), { maxBytesPerProject: 30 });
    await capped.initialize();

    const first = await publish(capped, "One", 20);
    await publish(capped, "Two", 20);

    const listed = await capped.listForProject("prj_a");
    expect(listed.map((record) => record.title)).toEqual(["Two"]);
    await expect(fs.access(capped.contentPath(first) as string)).rejects.toThrow();
  });

  test("never evicts a pinned artifact", async () => {
    const capped = new ArtifactStore(root, createTestLogger(), { maxPerProject: 2 });
    await capped.initialize();

    const first = await publish(capped, "Pinned", 8);
    await capped.setPinned(first.artifactId, true);
    const second = await publish(capped, "Two", 8);
    await publish(capped, "Three", 8);

    const listed = await capped.listForProject("prj_a");
    expect(listed.map((record) => record.title).sort()).toEqual(["Pinned", "Three"]);
    await expect(fs.access(capped.contentPath(second) as string)).rejects.toThrow();
    expect((await capped.readContent(first)).toString()).toBe("x".repeat(8));
  });

  test("never evicts the artifact being published, even over the byte cap", async () => {
    const capped = new ArtifactStore(root, createTestLogger(), { maxBytesPerProject: 4 });
    await capped.initialize();

    const only = await publish(capped, "Oversized for the cap", 40);

    expect(await capped.listForProject("prj_a")).toEqual([only]);
    expect((await capped.readContent(only)).byteLength).toBe(40);
  });

  test("pinned artifacts lead the list without changing recency", async () => {
    const first = await publish(store, "One", 8);
    const second = await publish(store, "Two", 8);
    await publish(store, "Three", 8);
    const pinnedFirst = await store.setPinned(first.artifactId, true);

    expect(pinnedFirst?.updatedAt).toBe(first.updatedAt);
    expect((await store.listForProject("prj_a")).map((record) => record.title)).toEqual([
      "One",
      "Three",
      "Two",
    ]);

    const pinnedSecond = await store.setPinned(second.artifactId, true);
    expect(pinnedSecond?.updatedAt).toBe(second.updatedAt);
    expect((await store.listForProject("prj_a")).map((record) => record.title)).toEqual([
      "Two",
      "One",
      "Three",
    ]);
    expect((await (await open()).listForProject("prj_a")).map((record) => record.title)).toEqual([
      "Two",
      "One",
      "Three",
    ]);

    await store.setPinned(first.artifactId, false);
    expect((await store.listForProject("prj_a")).map((record) => record.title)).toEqual([
      "Two",
      "Three",
      "One",
    ]);
    await store.setPinned(second.artifactId, false);
    expect((await store.listForProject("prj_a")).map((record) => record.title)).toEqual([
      "Three",
      "Two",
      "One",
    ]);
  });
});

describe("link-only artifacts", () => {
  const LINK = "https://claude.ai/code/artifact/abc";

  test("records a title and a destination with no stored bytes", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Published on claude.ai",
      externalUrl: LINK,
      origin: AGENT,
    });

    expect(record.size).toBeNull();
    expect(record.contentSha256).toBeNull();
    expect(record.externalUrl).toBe(LINK);
    // No digest, so no path: a link-only record names no file at all.
    expect(store.contentPath(record)).toBeNull();
  });

  test("reading one reports a link, not a missing artifact", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Linked",
      externalUrl: LINK,
      origin: AGENT,
    });
    await expect(store.readContent(record)).rejects.toMatchObject({
      code: "artifact_has_no_content",
    });
  });

  test("refuses a row with neither a document nor a destination", async () => {
    await expect(
      store.publish({ projectId: "prj_a", title: "Nothing", origin: AGENT }),
    ).rejects.toMatchObject({ code: "artifact_has_no_content" });
  });

  test("survives a restart — the sweep only claims files a digest names", async () => {
    const linked = await store.publish({
      projectId: "prj_a",
      title: "Linked",
      externalUrl: LINK,
      origin: AGENT,
    });
    const stored = await store.publish({
      projectId: "prj_a",
      title: "Stored",
      html: "<p>x</p>",
      origin: AGENT,
    });

    const reopened = await open();
    const titles = (await reopened.listForProject("prj_a")).map((record) => record.title);
    expect(titles.sort()).toEqual(["Linked", "Stored"]);
    expect((await reopened.readContent(stored.record)).toString()).toBe("<p>x</p>");
    await expect(reopened.readContent(linked.record)).rejects.toMatchObject({
      code: "artifact_has_no_content",
    });
  });

  test("overwriting a document with a link drops the bytes", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "Draft",
      html: "<p>v1</p>",
      origin: AGENT,
    });
    const second = await store.publish({
      projectId: "prj_a",
      title: "Moved to claude.ai",
      externalUrl: LINK,
      artifactId: first.record.artifactId,
      origin: AGENT,
    });

    expect(second.record.contentSha256).toBeNull();
    expect(store.contentPath(second.record)).toBeNull();
    // And the file it used to own must not survive as an orphan against the quota.
    await expect(fs.access(store.contentPath(first.record) as string)).rejects.toThrow();
    const reopened = await open();
    expect(await reopened.listForProject("prj_a")).toHaveLength(1);
  });

  test("overwriting a link with a document restores the bytes", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "Linked",
      externalUrl: LINK,
      origin: AGENT,
    });
    const second = await store.publish({
      projectId: "prj_a",
      title: "Now stored",
      html: "<p>v2</p>",
      artifactId: first.record.artifactId,
      origin: AGENT,
    });

    expect(second.record.contentSha256).not.toBeNull();
    expect((await store.readContent(second.record)).toString()).toBe("<p>v2</p>");
  });

  test("costs a slot but no bytes against the project quota", async () => {
    const capped = new ArtifactStore(root, createTestLogger(), { maxBytesPerProject: 30 });
    await capped.initialize();

    for (let index = 0; index < 4; index += 1) {
      await capped.publish({
        projectId: "prj_a",
        title: `Link ${index}`,
        externalUrl: `${LINK}/${index}`,
        origin: AGENT,
      });
    }
    // Zero bytes across four rows, so the byte cap never binds and nothing is evicted.
    expect(await capped.listForProject("prj_a")).toHaveLength(4);
  });
});

describe("delete", () => {
  test("removes the record and its content", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Doomed",
      html: "<p/>",
      origin: AGENT,
    });

    expect(await store.delete(record.artifactId)).toBe(true);
    expect(await store.listForProject("prj_a")).toEqual([]);
    await expect(fs.access(store.contentPath(record) as string)).rejects.toThrow();
  });

  test("is idempotent", async () => {
    expect(await store.delete("art_missing")).toBe(false);
  });

  test("cascades a whole project and can be retried", async () => {
    await store.publish({ projectId: "prj_a", title: "A", html: "<p/>", origin: AGENT });
    await store.publish({ projectId: "prj_a", title: "B", html: "<p/>", origin: AGENT });
    const kept = await store.publish({
      projectId: "prj_b",
      title: "C",
      html: "<p/>",
      origin: AGENT,
    });

    await store.deleteProject("prj_a");
    await store.deleteProject("prj_a");

    expect(await store.listForProject("prj_a")).toEqual([]);
    expect(await store.listForProject("prj_b")).toEqual([kept.record]);
    await expect(fs.access(path.join(root, "prj_a"))).rejects.toThrow();
  });
});

describe("startup sweep", () => {
  test("reclaims content no record names", async () => {
    await store.publish({ projectId: "prj_a", title: "Kept", html: "<p/>", origin: AGENT });
    const orphan = path.join(root, "prj_a", "art_orphan.html");
    await fs.writeFile(orphan, "<p>stale</p>");

    const reopened = await open();
    await expect(fs.access(orphan)).rejects.toThrow();
    expect(await reopened.listForProject("prj_a")).toHaveLength(1);
  });

  test("drops a record whose content is gone", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Broken",
      html: "<p/>",
      origin: AGENT,
    });
    await fs.rm(store.contentPath(record));

    const reopened = await open();
    expect(await reopened.listForProject("prj_a")).toEqual([]);
  });

  // A real projectId is a path — `remote:<host>/<owner>/<repo>`, or the project root path — so
  // its directory is several levels down and the depth varies by project. The flat ids the rest
  // of this file uses are the shape the sweep used to assume.
  test.each([
    ["a git remote", "remote:github.com/asln-digital/eclectic"],
    ["a project root path", path.join(os.tmpdir(), "paseo-project-root")],
  ])("keeps content published under %s", async (_label, projectId) => {
    const { record } = await store.publish({
      projectId,
      title: "Nested",
      html: "<p/>",
      origin: AGENT,
    });

    const reopened = await open();
    expect(await reopened.listForProject(projectId)).toHaveLength(1);
    await expect(fs.access(store.contentPath(record))).resolves.toBeUndefined();
  });

  test("reclaims an orphan nested under a multi-segment projectId", async () => {
    const projectId = "remote:github.com/asln-digital/eclectic";
    const { record } = await store.publish({
      projectId,
      title: "Kept",
      html: "<p/>",
      origin: AGENT,
    });
    const orphan = path.join(path.dirname(store.contentPath(record)!), "art_orphan.html");
    await fs.writeFile(orphan, "<p>stale</p>");

    const reopened = await open();
    await expect(fs.access(orphan)).rejects.toThrow();
    expect(await reopened.listForProject(projectId)).toHaveLength(1);
  });

  test("leaves the index alone", async () => {
    await store.publish({
      projectId: "remote:github.com/asln-digital/eclectic",
      title: "Kept",
      html: "<p/>",
      origin: AGENT,
    });

    await open();
    await expect(fs.access(path.join(root, "index.json"))).resolves.toBeUndefined();
  });
});

describe("readContent", () => {
  test("reports missing content rather than throwing an ENOENT", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Doomed",
      html: "<p>x</p>",
      origin: AGENT,
    });
    await fs.rm(store.contentPath(record) as string);

    await expect(store.readContent(record)).rejects.toBeInstanceOf(ArtifactError);
    await expect(store.readContent(record)).rejects.toMatchObject({
      code: "artifact_not_found",
    });
  });

  test("a crash between writing content and committing the index keeps the old version", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Draft",
      html: "<p>v1</p>",
      origin: AGENT,
    });

    // What `beforeWrite` does, without the index commit that would follow it: the new version
    // lands under its own digest and the old one is untouched, because nothing is removed until
    // the index no longer names it.
    const nextDigest = createHash("sha256").update("<p>v2</p>").digest("hex");
    await fs.writeFile(
      path.join(root, "prj_a", `${record.artifactId}.${nextDigest}.html`),
      "<p>v2</p>",
    );

    const reopened = await open();
    const [survivor] = await reopened.listForProject("prj_a");
    expect(survivor?.contentSha256).toBe(record.contentSha256);
    // The index still names v1, and v1 is still readable — no record pointing at nothing, and
    // no bytes served under a digest that does not describe them.
    expect((await reopened.readContent(record)).toString()).toBe("<p>v1</p>");
    // The half-written v2 is reclaimed rather than left counting against the quota.
    await expect(
      fs.access(path.join(root, "prj_a", `${record.artifactId}.${nextDigest}.html`)),
    ).rejects.toThrow();
  });

  test("a superseded record cannot read the version that replaced it", async () => {
    const first = await store.publish({
      projectId: "prj_a",
      title: "Draft",
      html: "<p>v1</p>",
      origin: AGENT,
    });
    const second = await store.publish({
      projectId: "prj_a",
      title: "Final",
      html: "<p>v2</p>",
      artifactId: first.record.artifactId,
      origin: AGENT,
    });

    // The whole point of digest-versioned paths: a caller holding stale metadata gets an error,
    // never the new bytes labelled with the old digest.
    await expect(store.readContent(first.record)).rejects.toMatchObject({
      code: "artifact_not_found",
    });
    expect((await store.readContent(second.record)).toString()).toBe("<p>v2</p>");
  });
});

describe("user publishes", () => {
  const USER = { agentId: null, workspaceId: null, provider: null };

  test("commits the pin and label with the document", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Doc",
      customTitle: "  Facilities  plan ",
      pinned: true,
      html: "<p>x</p>",
      origin: USER,
    });
    expect(record).toMatchObject({ title: "Doc", customTitle: "Facilities plan", pinned: true });
  });

  test("an invalid label stores nothing", async () => {
    await expect(
      store.publish({
        projectId: "prj_a",
        title: "Doc",
        customTitle: "   ",
        html: "<p>x</p>",
        origin: USER,
      }),
    ).rejects.toMatchObject({ code: "artifact_invalid_title" });
    expect(await store.listForProject("prj_a")).toEqual([]);
  });

  test("refuses a project id that walks out of the artifact root", async () => {
    for (const projectId of ["../outside", "a/../../outside", ""]) {
      await expect(
        store.publish({ projectId, title: "Doc", html: "<p>x</p>", origin: USER }),
      ).rejects.toMatchObject({ code: "artifact_invalid_project" });
    }
    await expect(fs.access(path.join(root, "..", "outside"))).rejects.toThrow();
  });

  test("refuses rather than evicts when eviction is not allowed", async () => {
    const capped = new ArtifactStore(root, createTestLogger(), { maxPerProject: 1 });
    await capped.initialize();
    const { record: kept } = await capped.publish({
      projectId: "prj_a",
      title: "Kept",
      html: "<p>kept</p>",
      origin: AGENT,
    });

    await expect(
      capped.publish({
        projectId: "prj_a",
        title: "Copy",
        html: "<p>copy</p>",
        allowEviction: false,
        origin: USER,
      }),
    ).rejects.toMatchObject({ code: "artifact_quota_exceeded" });
    expect((await capped.listForProject("prj_a")).map((r) => r.artifactId)).toEqual([
      kept.artifactId,
    ]);
    expect((await capped.readContent(kept)).toString()).toBe("<p>kept</p>");
  });

  test("no agent may overwrite an artifact the user owns", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Copied",
      html: "<p>v1</p>",
      origin: USER,
    });

    await expect(
      store.publish({
        projectId: "prj_a",
        title: "Hijacked",
        html: "<p>evil</p>",
        artifactId: record.artifactId,
        origin: AGENT,
      }),
    ).rejects.toMatchObject({ code: "artifact_forbidden" });
    expect((await store.readContent(record)).toString()).toBe("<p>v1</p>");
  });
});
