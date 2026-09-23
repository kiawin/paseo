import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  NOTE_MAX_BYTES,
  NOTE_QUARANTINE_FILENAME,
  NoteStore,
  type SaveNoteInput,
} from "./note-store.js";

let root: string;
let store: NoteStore;

async function open(): Promise<NoteStore> {
  const next = new NoteStore(root, createTestLogger());
  await next.initialize();
  return next;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "paseo-notes-"));
  store = await open();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("save", () => {
  test("publishes the record identity and change kind", async () => {
    const changes: Array<{
      projectId: string;
      noteId: string;
      revision: number | null;
      kind: "create" | "update" | "delete";
    }> = [];
    store.subscribeToDetailedChanges((change) => changes.push(change));

    const first = await store.save({ projectId: "prj_changes", body: "first" });
    const second = await store.save({
      projectId: "prj_changes",
      noteId: first.record.noteId,
      body: "second",
    });
    await store.delete(second.record.noteId, second.record.revision);

    expect(changes).toEqual([
      {
        projectId: "prj_changes",
        noteId: first.record.noteId,
        revision: 1,
        kind: "create",
      },
      {
        projectId: "prj_changes",
        noteId: first.record.noteId,
        revision: 2,
        kind: "update",
      },
      {
        projectId: "prj_changes",
        noteId: first.record.noteId,
        revision: null,
        kind: "delete",
      },
    ]);
  });

  test("hashes opaque project ids into distinct safe directories", async () => {
    const legacy = await store.save({
      projectId: "remote:github.com/acme/repo",
      body: "# Legacy",
    });
    const slashProject = await store.save({ projectId: "/a/b", body: "Slash" });
    const hyphenProject = await store.save({ projectId: "/a-b", body: "Hyphen" });

    const legacyDirectory = path.basename(path.dirname(store.contentPath(legacy.record)));
    const slashDirectory = path.basename(path.dirname(store.contentPath(slashProject.record)));
    const hyphenDirectory = path.basename(path.dirname(store.contentPath(hyphenProject.record)));

    expect(legacyDirectory).toMatch(/^[0-9a-f]{64}$/u);
    expect(legacyDirectory).not.toContain(":");
    expect(legacyDirectory).not.toContain("/");
    expect(slashDirectory).not.toBe(hyphenDirectory);
  });

  test("derives a title from a heading anywhere in the body", async () => {
    const saved = await store.save({
      projectId: "prj_titles",
      body: "introductory text\n\n## The real title\n\nbody",
    });

    expect(saved.record.displayTitle).toBe("The real title");
  });

  test("ignores YAML frontmatter when deriving a title", async () => {
    const saved = await store.save({
      projectId: "prj_titles",
      body: "---\ntitle: Metadata title\n---\n# The real title",
    });

    expect(saved.record.displayTitle).toBe("The real title");
  });

  test("uses the first non-empty line without a heading", async () => {
    const saved = await store.save({
      projectId: "prj_titles",
      body: "\n  First   line  \nsecond line",
    });

    expect(saved.record.displayTitle).toBe("First line");
  });

  test("uses a creation stamp for an empty body", async () => {
    const saved = await store.save({ projectId: "prj_titles", body: "" });

    expect(saved.record.displayTitle).toBe(`Note created ${saved.record.createdAt}`);
  });

  test("truncates a long heading to the title limit", async () => {
    const saved = await store.save({
      projectId: "prj_titles",
      body: `# ${"x".repeat(250)}`,
    });

    expect(saved.record.displayTitle).toHaveLength(200);
    expect(saved.record.displayTitle).toBe("x".repeat(200));
  });

  test("enforces the note byte limit at the UTF-8 boundary", async () => {
    const exactBody = "é".repeat(NOTE_MAX_BYTES / 2);
    const exact = await store.save({ projectId: "prj_bytes", body: exactBody });

    expect(Buffer.byteLength(exactBody, "utf8")).toBe(NOTE_MAX_BYTES);
    expect(exact.record.size).toBe(NOTE_MAX_BYTES);
    await expect(
      store.save({ projectId: "prj_bytes", body: "x".repeat(NOTE_MAX_BYTES + 1) }),
    ).rejects.toMatchObject({ code: "note_too_large" });
    expect(await store.listForProject("prj_bytes")).toEqual([exact.record]);
  });

  test("rejects count and byte caps instead of evicting", async () => {
    const capped = new NoteStore(root, createTestLogger(), {
      maxPerProject: 2,
      maxBytesPerProject: 10,
    });
    await capped.initialize();

    const first = await capped.save({ projectId: "prj_count", body: "one" });
    const second = await capped.save({ projectId: "prj_count", body: "two" });
    await expect(capped.save({ projectId: "prj_count", body: "three" })).rejects.toMatchObject({
      code: "note_project_limit",
    });
    expect(await capped.listForProject("prj_count")).toEqual([second.record, first.record]);

    const bytes = await capped.save({ projectId: "prj_bytes", body: "12345678" });
    await expect(capped.save({ projectId: "prj_bytes", body: "123" })).rejects.toMatchObject({
      code: "note_project_limit",
    });
    expect(await capped.listForProject("prj_bytes")).toEqual([bytes.record]);
  });

  test("uses last-writer-wins and reports the replaced revision", async () => {
    const first = await store.save({ projectId: "prj_lww", body: "first" });
    const stale = await store.save({
      projectId: "prj_lww",
      noteId: first.record.noteId,
      body: "second",
    });

    expect(stale.record.revision).toBe(2);
    expect(stale.replaced?.revision).toBe(1);
    expect(stale.replaced?.contentSha256).toBe(first.record.contentSha256);
    expect((await store.readContent(stale.record)).toString()).toBe("second");
    await expect(store.readContent(first.record)).rejects.toMatchObject({ code: "note_not_found" });
  });

  test("serializes replaced-body cleanup with a later save reusing the old digest", async () => {
    const first = await store.save({ projectId: "prj_queue", body: "old" });
    const oldPath = store.contentPath(first.record);
    let releaseUnlink!: () => void;
    let unlinkStarted!: () => void;
    const unlinkGate = new Promise<void>((resolve) => {
      releaseUnlink = resolve;
    });
    const unlinkObserved = new Promise<void>((resolve) => {
      unlinkStarted = resolve;
    });
    const remove = fs.rm.bind(fs);
    const removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === oldPath) {
        unlinkStarted();
        await unlinkGate;
      }
      return remove(target, options);
    });

    try {
      const replacing = store.save({
        projectId: "prj_queue",
        noteId: first.record.noteId,
        body: "new",
      });
      await unlinkObserved;

      let reusedFinished = false;
      const reused = store
        .save({ projectId: "prj_queue", noteId: first.record.noteId, body: "old" })
        .then((result) => {
          reusedFinished = true;
          return result;
        });
      await Promise.resolve();
      expect(reusedFinished).toBe(false);

      releaseUnlink();
      const [, finalSave] = await Promise.all([replacing, reused]);
      await expect(store.readContent(finalSave.record)).resolves.toEqual(Buffer.from("old"));
    } finally {
      removeSpy.mockRestore();
    }
  });

  test("refuses a save for an unknown note id", async () => {
    await expect(
      store.save({ projectId: "prj_missing", noteId: "note_missing", body: "ghost" }),
    ).rejects.toMatchObject({ code: "note_not_found" });
    expect(await store.listForProject("prj_missing")).toEqual([]);
  });

  test("rejects a missing body at runtime", async () => {
    await expect(
      store.save({ projectId: "prj_invalid" } as unknown as SaveNoteInput),
    ).rejects.toMatchObject({
      code: "note_invalid_body",
    });
  });
});

describe("delete", () => {
  test("requires the current revision and removes the matching note", async () => {
    const first = await store.save({ projectId: "prj_delete", body: "first" });
    const current = await store.save({
      projectId: "prj_delete",
      noteId: first.record.noteId,
      body: "current",
    });

    await expect(store.delete(current.record.noteId, first.record.revision)).rejects.toMatchObject({
      code: "note_revision_conflict",
      currentRevision: 2,
    });
    expect(await store.listForProject("prj_delete")).toEqual([current.record]);

    await expect(
      store.delete(current.record.noteId, current.record.revision),
    ).resolves.toBeUndefined();
    expect(await store.listForProject("prj_delete")).toEqual([]);
    await expect(fs.access(store.contentPath(current.record))).rejects.toThrow();
  });
});

describe("sweep safety", () => {
  test("preserves records and bodies when a project directory scan fails", async () => {
    const saved = await store.save({ projectId: "prj_unreadable", body: "keep me" });
    const bodyPath = store.contentPath(saved.record);
    const rootEntries = await fs.readdir(root, { withFileTypes: true });
    const readError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
      errno: -13,
    });
    const readdir = vi
      .spyOn(fs, "readdir")
      .mockResolvedValueOnce(rootEntries)
      .mockRejectedValueOnce(readError);

    try {
      const reopened = await open();
      expect(await reopened.listForProject("prj_unreadable")).toEqual([saved.record]);
      await expect(fs.access(bodyPath)).resolves.toBeUndefined();
    } finally {
      readdir.mockRestore();
    }
  });
});

describe("digest ordering", () => {
  test("keeps the old body while a new digest is not indexed", async () => {
    const first = await store.save({ projectId: "prj_order", body: "old" });
    const nextBody = "new";
    const nextDigest = createHash("sha256").update(nextBody).digest("hex");
    const nextPath = path.join(
      path.dirname(store.contentPath(first.record)),
      `${first.record.noteId}.${nextDigest}.md`,
    );

    await fs.writeFile(nextPath, nextBody);
    await expect(fs.access(store.contentPath(first.record))).resolves.toBeUndefined();

    const reopened = await open();
    await expect(fs.access(store.contentPath(first.record))).resolves.toBeUndefined();
    await expect(fs.access(nextPath)).rejects.toThrow();
    expect((await reopened.readContent(first.record)).toString()).toBe("old");
  });
});

describe("quarantine", () => {
  test("preserves bodies, blocks mutations, and survives restart", async () => {
    const saved = await store.save({ projectId: "prj_corrupt", body: "keep me" });
    const bodyPath = store.contentPath(saved.record);
    const orphanPath = path.join(path.dirname(bodyPath), "note_orphan.deadbeef.md");
    await fs.writeFile(path.join(root, "index.json"), "{not-json");
    await fs.writeFile(orphanPath, "orphan");

    const quarantined = await open();
    await expect(fs.access(bodyPath)).resolves.toBeUndefined();
    await expect(fs.access(orphanPath)).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, NOTE_QUARANTINE_FILENAME))).resolves.toBeUndefined();
    await expect(quarantined.save({ projectId: "prj_corrupt", body: "blocked" })).rejects.toThrow(
      "blocked until daemon restart",
    );

    const restarted = await open();
    await expect(fs.access(bodyPath)).resolves.toBeUndefined();
    await expect(fs.access(orphanPath)).resolves.toBeUndefined();
    await expect(
      restarted.save({ projectId: "prj_corrupt", body: "still blocked" }),
    ).rejects.toThrow("blocked until daemon restart");
  });
});

describe("project cascade", () => {
  test("removes a project's notes and bodies idempotently", async () => {
    const first = await store.save({ projectId: "prj_remove", body: "one" });
    const second = await store.save({ projectId: "prj_remove", body: "two" });
    const kept = await store.save({ projectId: "prj_keep", body: "keep" });

    await store.deleteProject("prj_remove");
    await store.deleteProject("prj_remove");

    expect(await store.listForProject("prj_remove")).toEqual([]);
    await expect(fs.access(store.contentPath(first.record))).rejects.toThrow();
    await expect(fs.access(store.contentPath(second.record))).rejects.toThrow();
    expect(await store.listForProject("prj_keep")).toEqual([kept.record]);
    await expect(fs.access(store.contentPath(kept.record))).resolves.toBeUndefined();
  });
});
