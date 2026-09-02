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
    expect((await store.readContent(record.artifactId)).toString()).toBe("<h1>hi</h1>");
    expect(store.contentPath(record)).toBe(path.join(root, "prj_a", `${record.artifactId}.html`));
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
    expect((await store.readContent(first.record.artifactId)).toString()).toBe("<p>v2</p>");
    expect(await store.listForProject("prj_a")).toHaveLength(1);
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
    expect((await store.readContent(record.artifactId)).toString()).toBe("<p>v1</p>");
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
    await expect(fs.access(capped.contentPath(first))).rejects.toThrow();
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
    await expect(fs.access(capped.contentPath(second))).rejects.toThrow();
  });

  test("evicts on the byte cap as well as the count cap", async () => {
    const capped = new ArtifactStore(root, createTestLogger(), { maxBytesPerProject: 30 });
    await capped.initialize();

    const first = await publish(capped, "One", 20);
    await publish(capped, "Two", 20);

    const listed = await capped.listForProject("prj_a");
    expect(listed.map((record) => record.title)).toEqual(["Two"]);
    await expect(fs.access(capped.contentPath(first))).rejects.toThrow();
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
    await expect(fs.access(capped.contentPath(second))).rejects.toThrow();
    expect((await capped.readContent(first.artifactId)).toString()).toBe("x".repeat(8));
  });

  test("never evicts the artifact being published, even over the byte cap", async () => {
    const capped = new ArtifactStore(root, createTestLogger(), { maxBytesPerProject: 4 });
    await capped.initialize();

    const only = await publish(capped, "Oversized for the cap", 40);

    expect(await capped.listForProject("prj_a")).toEqual([only]);
    expect((await capped.readContent(only.artifactId)).byteLength).toBe(40);
  });

  test("pinning does not reorder the list", async () => {
    const first = await publish(store, "One", 8);
    await publish(store, "Two", 8);
    await store.setPinned(first.artifactId, true);

    const listed = await store.listForProject("prj_a");
    expect(listed.map((record) => record.title)).toEqual(["Two", "One"]);
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
    await expect(fs.access(store.contentPath(record))).rejects.toThrow();
  });

  test("reading one reports a link, not a missing artifact", async () => {
    const { record } = await store.publish({
      projectId: "prj_a",
      title: "Linked",
      externalUrl: LINK,
      origin: AGENT,
    });
    await expect(store.readContent(record.artifactId)).rejects.toMatchObject({
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
    expect((await reopened.readContent(stored.record.artifactId)).toString()).toBe("<p>x</p>");
    await expect(reopened.readContent(linked.record.artifactId)).rejects.toMatchObject({
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
    await expect(fs.access(store.contentPath(second.record))).rejects.toThrow();
    // And the file it used to own must not survive as an orphan against the quota.
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
    expect((await store.readContent(first.record.artifactId)).toString()).toBe("<p>v2</p>");
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
    await expect(fs.access(store.contentPath(record))).rejects.toThrow();
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
});

describe("readContent", () => {
  test("reports a missing artifact rather than throwing an ENOENT", async () => {
    await expect(store.readContent("art_missing")).rejects.toBeInstanceOf(ArtifactError);
    await expect(store.readContent("art_missing")).rejects.toMatchObject({
      code: "artifact_not_found",
    });
  });
});
