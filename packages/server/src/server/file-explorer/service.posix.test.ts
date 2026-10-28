// POSIX-only: symlink fixtures
/* eslint-disable max-nested-callbacks */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExplorerEntry,
  createUploadSink,
  deleteExplorerEntry,
  getDownloadableEntryInfo,
  getDownloadableFileInfo,
  listDirectoryEntries,
  readExplorerFile,
  renameExplorerEntry,
  writeExplorerFile,
} from "./service.js";
import { isPlatform } from "../../test-utils/platform.js";

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe.skipIf(isPlatform("win32"))("service POSIX-only", () => {
  it("lists directory entries even when a dangling symlink exists", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      await mkdir(path.join(root, "packages", "server"), { recursive: true });
      const serverDir = path.join(root, "packages", "server");
      await writeFile(path.join(serverDir, "README.md"), "# server\n", "utf-8");
      await symlink("CLAUDE.md", path.join(serverDir, "AGENTS.md"));

      const result = await listDirectoryEntries({
        root,
        relativePath: "packages/server",
      });

      expect(result.path).toBe("packages/server");
      const names = result.entries.map((entry) => entry.name);
      expect(names).toContain("README.md");
      expect(names).not.toContain("AGENTS.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked files that resolve outside the workspace", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    const outsideRoot = await createTempDir("paseo-file-explorer-outside-");

    try {
      const externalFile = path.join(outsideRoot, "secret.txt");
      await writeFile(externalFile, "top secret\n", "utf-8");
      await symlink(externalFile, path.join(root, "secret-link.txt"));

      await expect(
        readExplorerFile({
          root,
          relativePath: "secret-link.txt",
        }),
      ).rejects.toThrow("Access outside of workspace is not allowed");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("skips listed symlink entries that resolve outside the workspace", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    const outsideRoot = await createTempDir("paseo-file-explorer-outside-");

    try {
      await writeFile(path.join(root, "visible.txt"), "visible\n", "utf-8");
      const externalFile = path.join(outsideRoot, "secret.txt");
      await writeFile(externalFile, "top secret\n", "utf-8");
      await symlink(externalFile, path.join(root, "secret-link.txt"));

      const result = await listDirectoryEntries({ root });

      const names = result.entries.map((entry) => entry.name);
      expect(names).toContain("visible.txt");
      expect(names).not.toContain("secret-link.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("lists a symlinked folder inside the workspace as a browsable directory", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      await mkdir(path.join(root, "real"));
      await writeFile(path.join(root, "real", "inner.txt"), "inner\n", "utf-8");
      await symlink("real", path.join(root, "linked"));

      const result = await listDirectoryEntries({ root });
      const linked = result.entries.find((entry) => entry.name === "linked");
      expect(linked?.kind).toBe("directory");

      const nested = await listDirectoryEntries({ root, relativePath: "linked" });
      expect(nested.path).toBe("linked");
      expect(nested.entries.map((entry) => entry.path)).toEqual(["linked/inner.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses canonical paths for downloadable symlink targets inside the workspace", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const target = path.join(root, "safe.txt");
      const link = path.join(root, "safe-link.txt");
      await writeFile(target, "safe\n", "utf-8");
      await symlink("safe.txt", link);

      const file = await readExplorerFile({
        root,
        relativePath: "safe-link.txt",
      });
      const info = await getDownloadableFileInfo({
        root,
        relativePath: "safe-link.txt",
      });

      expect(file.path).toBe("safe-link.txt");
      expect(file.content).toBe("safe\n");
      expect(info.path).toBe("safe-link.txt");
      expect(info.fileName).toBe("safe-link.txt");
      expect(info.absolutePath).toBe(await realpath(target));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface LinkedWorktreeFixture {
  mainCheckout: string;
  worktree: string;
  outside: string;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/**
 * A main checkout with a linked worktree whose `data/site` links back into the main
 * checkout, the way a worktree setup script keeps ignored data outside the worktree.
 */
async function createLinkedWorktree(base: string): Promise<LinkedWorktreeFixture> {
  const mainCheckout = path.join(base, "repo");
  const worktree = path.join(base, "repo-worktrees", "feature");
  const outside = path.join(base, "outside");
  await mkdir(path.join(mainCheckout, "data", "site", "rounds", "r1"), { recursive: true });
  await writeFile(path.join(mainCheckout, "data", "site", "rounds", "r1", "records.jsonl"), "{}\n");
  await writeFile(path.join(mainCheckout, ".gitignore"), "data/\n");
  git(mainCheckout, ["init", "-b", "main"]);
  git(mainCheckout, ["add", ".gitignore"]);
  git(mainCheckout, [
    "-c",
    "user.email=test@getpaseo.local",
    "-c",
    "user.name=Paseo Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial",
  ]);
  git(mainCheckout, ["worktree", "add", "-b", "feature", worktree]);
  await mkdir(path.join(worktree, "data"));
  await symlink(path.join(mainCheckout, "data", "site"), path.join(worktree, "data", "site"));
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "top secret\n");
  return { mainCheckout, worktree, outside };
}

describe.skipIf(isPlatform("win32"))("service in a linked git worktree", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const dir of cleanup.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function setup(): Promise<LinkedWorktreeFixture> {
    const base = await realpath(await createTempDir("paseo-file-explorer-worktree-"));
    cleanup.push(base);
    return createLinkedWorktree(base);
  }

  it("lists a link into the main checkout as a directory and reads its files", async () => {
    const { mainCheckout, worktree } = await setup();

    const data = await listDirectoryEntries({ root: worktree, relativePath: "data" });
    expect(data.entries.map((entry) => [entry.path, entry.kind])).toEqual([
      ["data/site", "directory"],
    ]);

    const round = await listDirectoryEntries({
      root: worktree,
      relativePath: "data/site/rounds/r1",
    });
    expect(round.path).toBe("data/site/rounds/r1");
    expect(round.entries.map((entry) => entry.path)).toEqual(["data/site/rounds/r1/records.jsonl"]);

    const file = await readExplorerFile({
      root: worktree,
      relativePath: "data/site/rounds/r1/records.jsonl",
    });
    expect(file.path).toBe("data/site/rounds/r1/records.jsonl");
    expect(file.content).toBe("{}\n");

    const download = await getDownloadableFileInfo({
      root: worktree,
      relativePath: "data/site/rounds/r1/records.jsonl",
    });
    expect(download.path).toBe("data/site/rounds/r1/records.jsonl");
    expect(download.absolutePath).toBe(
      path.join(mainCheckout, "data", "site", "rounds", "r1", "records.jsonl"),
    );

    const archive = await getDownloadableEntryInfo({ root: worktree, relativePath: "data/site" });
    expect(archive).toMatchObject({ path: "data/site", kind: "directory", fileName: "site.zip" });
  });

  it("still refuses a link to a folder outside both checkouts", async () => {
    const { worktree, outside } = await setup();
    await symlink(outside, path.join(worktree, "escape"));

    const root = await listDirectoryEntries({ root: worktree });
    expect(root.entries.map((entry) => entry.name)).not.toContain("escape");
    await expect(
      readExplorerFile({ root: worktree, relativePath: "escape/secret.txt" }),
    ).rejects.toThrow("Access outside of workspace is not allowed");
    await expect(
      createUploadSink({ root: worktree, relativePath: "escape/new.txt", overwrite: "fail" }),
    ).rejects.toThrow("Access outside of workspace is not allowed");
  });

  it("still refuses a requested path that climbs out of the worktree", async () => {
    const { worktree } = await setup();

    await expect(listDirectoryEntries({ root: worktree, relativePath: "../x" })).rejects.toThrow(
      "Access outside of workspace is not allowed",
    );
    // The main checkout counts only as a link target, never as a path to ask for.
    await expect(
      readExplorerFile({
        root: worktree,
        relativePath: "../../repo/data/site/rounds/r1/records.jsonl",
      }),
    ).rejects.toThrow("Access outside of workspace is not allowed");
  });

  it("does not widen the main checkout or a non-git folder", async () => {
    const { mainCheckout, outside } = await setup();
    await symlink(outside, path.join(mainCheckout, "escape"));
    const plain = await realpath(await createTempDir("paseo-file-explorer-plain-"));
    cleanup.push(plain);
    await symlink(path.join(mainCheckout, "data"), path.join(plain, "data"));

    const main = await listDirectoryEntries({ root: mainCheckout });
    expect(main.entries.map((entry) => entry.name)).not.toContain("escape");
    await expect(
      readExplorerFile({ root: mainCheckout, relativePath: "escape/secret.txt" }),
    ).rejects.toThrow("Access outside of workspace is not allowed");

    const listing = await listDirectoryEntries({ root: plain });
    expect(listing.entries).toEqual([]);
    await expect(
      readExplorerFile({ root: plain, relativePath: "data/site/rounds/r1/records.jsonl" }),
    ).rejects.toThrow("Access outside of workspace is not allowed");
  });

  it("skips a dangling link into the main checkout", async () => {
    const { mainCheckout, worktree } = await setup();
    await symlink(path.join(mainCheckout, "data", "gone"), path.join(worktree, "data", "gone"));

    const data = await listDirectoryEntries({ root: worktree, relativePath: "data" });
    expect(data.entries.map((entry) => entry.name)).toEqual(["site"]);
  });

  it("writes through a link into the main checkout and reports worktree paths", async () => {
    const { mainCheckout, worktree } = await setup();
    const round = path.join(mainCheckout, "data", "site", "rounds", "r1");

    const current = await readExplorerFile({
      root: worktree,
      relativePath: "data/site/rounds/r1/records.jsonl",
    });
    await expect(
      writeExplorerFile({
        root: worktree,
        relativePath: "data/site/rounds/r1/records.jsonl",
        content: "[]\n",
        expectedRevision: current.revision,
      }),
    ).resolves.toMatchObject({ status: "written" });
    expect(await readFile(path.join(round, "records.jsonl"), "utf-8")).toBe("[]\n");

    await expect(
      createExplorerEntry({
        root: worktree,
        parentPath: "data/site/rounds/r1",
        name: "notes.txt",
        kind: "file",
      }),
    ).resolves.toEqual({ status: "ok", path: "data/site/rounds/r1/notes.txt" });
    await expect(
      renameExplorerEntry({
        root: worktree,
        relativePath: "data/site/rounds/r1/notes.txt",
        name: "log.txt",
      }),
    ).resolves.toEqual({ status: "ok", path: "data/site/rounds/r1/log.txt" });
    await expect(
      deleteExplorerEntry({ root: worktree, relativePath: "data/site/rounds/r1/log.txt" }),
    ).resolves.toEqual({ status: "ok", path: "data/site/rounds/r1/log.txt" });

    const upload = await createUploadSink({
      root: worktree,
      relativePath: "data/site/rounds/r2/report.txt",
      overwrite: "fail",
      createMissingDirectories: true,
    });
    expect(upload.targetPath).toBe("data/site/rounds/r2/report.txt");
    await upload.write(new TextEncoder().encode("report"));
    await expect(upload.commit()).resolves.toMatchObject({
      path: "data/site/rounds/r2/report.txt",
    });

    expect(
      await readFile(
        path.join(mainCheckout, "data", "site", "rounds", "r2", "report.txt"),
        "utf-8",
      ),
    ).toBe("report");
    const listing = await listDirectoryEntries({
      root: worktree,
      relativePath: "data/site/rounds/r1",
    });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["records.jsonl"]);
  });
});
