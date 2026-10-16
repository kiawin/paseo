import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applyCapturedChanges,
  buildMoveToWorktreePrompt,
  captureUncommittedChanges,
  resolveCurrentBranch,
} from "./move-to-worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

describe("move-to-worktree", () => {
  let tempDir: string;
  let repoDir: string;
  let worktreeDir: string;

  beforeEach(async () => {
    tempDir = realpathSync.native(await mkdtemp(join(tmpdir(), "paseo-move-to-worktree-")));
    repoDir = join(tempDir, "repo");
    worktreeDir = join(tempDir, "worktree");
    execFileSync("git", ["init", repoDir], { stdio: "pipe" });
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(repoDir, "README.md"), "hello\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "init"]);
    git(repoDir, ["branch", "-M", "main"]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("copies tracked and untracked changes into a worktree without touching the source", async () => {
    await writeFile(join(repoDir, "README.md"), "hello\nchanged\n");
    await writeFile(join(repoDir, "notes.txt"), "draft\n");
    const statusBefore = git(repoDir, ["status", "--porcelain"]);

    const captured = await captureUncommittedChanges(repoDir);
    git(repoDir, ["worktree", "add", "-b", "feature", worktreeDir, "main"]);
    await applyCapturedChanges(captured, worktreeDir);

    expect(await readFile(join(worktreeDir, "README.md"), "utf8")).toBe("hello\nchanged\n");
    expect(await readFile(join(worktreeDir, "notes.txt"), "utf8")).toBe("draft\n");
    expect(git(repoDir, ["status", "--porcelain"])).toBe(statusBefore);
    expect(git(repoDir, ["stash", "list"])).toBe("");
    expect(git(repoDir, ["branch", "--show-current"])).toBe("main");
    expect(git(worktreeDir, ["status", "--porcelain", "--", "notes.txt"])).toBe("?? notes.txt");
  });

  test("copies what the checkout held at capture, not later edits by other agents", async () => {
    await writeFile(join(repoDir, "notes.txt"), "at capture\n");
    const captured = await captureUncommittedChanges(repoDir);
    await writeFile(join(repoDir, "notes.txt"), "edited later\n");

    git(repoDir, ["worktree", "add", "-b", "feature", worktreeDir, "main"]);
    await applyCapturedChanges(captured, worktreeDir);

    expect(await readFile(join(worktreeDir, "notes.txt"), "utf8")).toBe("at capture\n");
  });

  // Creating symlinks needs elevated privileges on Windows.
  test.skipIf(process.platform === "win32")(
    "keeps relative symlinks relative so they never point back into the shared checkout",
    async () => {
      await symlink("README.md", join(repoDir, "link.md"));
      const captured = await captureUncommittedChanges(repoDir);

      git(repoDir, ["worktree", "add", "-b", "feature", worktreeDir, "main"]);
      await applyCapturedChanges(captured, worktreeDir);

      expect(await readlink(join(worktreeDir, "link.md"))).toBe("README.md");
    },
  );

  test("captures nothing from a clean checkout", async () => {
    const captured = await captureUncommittedChanges(repoDir);

    expect(captured).toEqual({ stashCommit: null, untrackedTree: null });
  });

  test("refuses a detached HEAD", async () => {
    git(repoDir, ["checkout", "--detach"]);

    await expect(resolveCurrentBranch(repoDir)).rejects.toThrow("detached HEAD");
  });

  test("tells the new agent where the work moved and what to do", () => {
    const prompt = buildMoveToWorktreePrompt({
      history: "Chat history",
      task: "Add the retry",
      sourceCwd: "/repo",
      worktreeCwd: "/worktrees/feature",
      branchName: "feature",
      baseBranch: "main",
      carriedChanges: null,
    });

    expect(prompt).toBe(
      [
        "Chat history",
        "",
        "You are taking over the task above. The previous agent moved it out of the shared checkout at /repo into a Paseo worktree:",
        "- Worktree: /worktrees/feature",
        "- Branch: feature, created from main",
        "- No uncommitted changes were copied from the shared checkout.",
        "Work only in this worktree.",
        "",
        "Task:",
        "Add the retry",
      ].join("\n"),
    );
  });
});
