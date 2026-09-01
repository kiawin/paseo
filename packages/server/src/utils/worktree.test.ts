import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createWorktree as createWorktreePrimitive,
  deriveWorktreeProjectHash,
  deletePaseoWorktree,
  classifyWorktreeRemovalRefusal,
  getPaseoWorktreesRoot,
  resolveCustomWorktreeRoot,
  resolveWorktreeHolderDir,
  isPaseoOwnedWorktreeCwd,
  listPaseoWorktrees,
  listRepoWorktrees,
  mapWorkspaceCwdToWorktree,
  slugify,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "./worktree";
import { execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { isAbsolute, join, relative, sep } from "path";
import { tmpdir } from "os";
import { createRealpathAwarePathMatcher } from "./path";

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;
  runSetup?: boolean;
  paseoHome?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    paseoHome: options.paseoHome,
  });
}

describe("paseo worktree manager", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-manager-test-")));
    repoDir = join(tempDir, "test-repo");
    paseoHome = join(tempDir, "paseo-home");

    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
      cwd: repoDir,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("treats a worktree as paseo-owned even when its .git admin is missing", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "orphan-admin-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "orphan-admin",
      paseoHome,
    });

    // Simulate a previous archive attempt that removed git's admin dir but left
    // the working tree on disk (e.g. because file churn prevented full cleanup).
    rmSync(join(repoDir, ".git", "worktrees", "orphan-admin"), {
      recursive: true,
      force: true,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    const ownership = await isPaseoOwnedWorktreeCwd(created.worktreePath, { paseoHome });
    expect(ownership.allowed).toBe(true);
    await expect(
      isPaseoOwnedWorktreeCwd(join(created.worktreePath, "packages", "app"), { paseoHome }),
    ).resolves.toMatchObject({
      allowed: true,
      worktreePath: created.worktreePath,
    });
  });

  it("lists hand-cut worktrees that the paseo-owned listing filters out", async () => {
    const paseoOwned = await createLegacyWorktreeForTest({
      branchName: "paseo-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "paseo-cut",
      paseoHome,
    });
    const handCutPath = join(tempDir, "hand-cut");
    execFileSync("git", ["worktree", "add", "-b", "hand-branch", handCutPath], { cwd: repoDir });

    // Paths are compared through the realpath-aware matcher rather than by string:
    // git reports the long form of a Windows path while the created worktree carries
    // the 8.3 short form, and macOS adds the /private symlink on top of that.
    const isPaseoCut = createRealpathAwarePathMatcher(paseoOwned.worktreePath);
    const isHandCut = createRealpathAwarePathMatcher(handCutPath);
    const isRepoRoot = createRealpathAwarePathMatcher(repoDir);

    const paseoOnly = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
    expect(paseoOnly).toHaveLength(1);
    expect(isPaseoCut(paseoOnly[0]?.path ?? "")).toBe(true);

    const all = await listRepoWorktrees({ cwd: repoDir });
    expect(all).toHaveLength(3);
    expect(all.some((entry) => isHandCut(entry.path))).toBe(true);
    expect(all.some((entry) => isPaseoCut(entry.path))).toBe(true);

    const mainWorktrees = all.filter((entry) => entry.isMainWorktree);
    expect(mainWorktrees).toHaveLength(1);
    expect(isRepoRoot(mainWorktrees[0]?.path ?? "")).toBe(true);

    expect(all.find((entry) => isHandCut(entry.path))?.branchName).toBe("hand-branch");
  });

  it("rejects paths that are not under the paseo worktrees root", async () => {
    const outsidePath = join(tempDir, "outside-paseo-home");
    mkdirSync(outsidePath, { recursive: true });

    const ownership = await isPaseoOwnedWorktreeCwd(outsidePath, { paseoHome });

    expect(ownership.allowed).toBe(false);
  });

  it("reports the source checkout root separately from Git's common directory", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "placement-root-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "placement-root",
      paseoHome,
    });

    const ownership = await isPaseoOwnedWorktreeCwd(created.worktreePath, { paseoHome });

    expect(ownership.allowed).toBe(true);
    expect(createRealpathAwarePathMatcher(repoDir)(ownership.repoRoot ?? "")).toBe(true);
    expect(createRealpathAwarePathMatcher(created.worktreePath)(ownership.worktreePath ?? "")).toBe(
      true,
    );
  });

  it("maps only root-contained workspace paths into a replacement worktree", () => {
    const sourceWorktreePath = join(tempDir, "source-worktree");
    const targetWorktreePath = join(tempDir, "target-worktree");
    const nestedWorkspaceCwd = join(sourceWorktreePath, "packages", "app");

    expect(
      mapWorkspaceCwdToWorktree({
        sourceWorktreePath,
        workspaceCwd: sourceWorktreePath,
        targetWorktreePath,
      }),
    ).toBe(targetWorktreePath);
    expect(
      mapWorkspaceCwdToWorktree({
        sourceWorktreePath,
        workspaceCwd: nestedWorkspaceCwd,
        targetWorktreePath,
      }),
    ).toBe(join(targetWorktreePath, "packages", "app"));
    expect(() =>
      mapWorkspaceCwdToWorktree({
        sourceWorktreePath,
        workspaceCwd: join(tempDir, "outside-worktree"),
        targetWorktreePath,
      }),
    ).toThrow("outside its source worktree");
  });

  it.skipIf(process.platform === "win32")(
    "maps a realpath-equivalent source workspace into the matching target subdirectory",
    () => {
      const sourceWorktreePath = join(tempDir, "source-worktree");
      const workspaceCwd = join(sourceWorktreePath, "packages", "app");
      const sourceAlias = join(tempDir, "source-alias");
      const targetWorktreePath = join(tempDir, "target-worktree");
      mkdirSync(workspaceCwd, { recursive: true });
      symlinkSync(sourceWorktreePath, sourceAlias, "dir");

      expect(
        mapWorkspaceCwdToWorktree({
          sourceWorktreePath: sourceAlias,
          workspaceCwd,
          targetWorktreePath,
        }),
      ).toBe(join(targetWorktreePath, "packages", "app"));
    },
  );

  it("rejects the worktrees root itself and the per-repo hash dir", async () => {
    const projectHash = await deriveWorktreeProjectHash(repoDir);
    const worktreesRoot = join(paseoHome, "worktrees");
    const projectHashDir = join(worktreesRoot, projectHash);
    mkdirSync(projectHashDir, { recursive: true });

    await expect(isPaseoOwnedWorktreeCwd(worktreesRoot, { paseoHome })).resolves.toMatchObject({
      allowed: false,
    });
    await expect(isPaseoOwnedWorktreeCwd(projectHashDir, { paseoHome })).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("deletes a worktree whose .git admin dir has already been removed", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "orphan-delete-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "orphan-delete",
      paseoHome,
    });

    rmSync(join(repoDir, ".git", "worktrees", "orphan-delete"), {
      recursive: true,
      force: true,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    await deletePaseoWorktree({
      cwd: repoDir,
      worktreePath: created.worktreePath,
      paseoHome,
    });

    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("is idempotent: deleting an already-absent worktree succeeds", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "idempotent-delete-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "idempotent-delete",
      paseoHome,
    });

    await deletePaseoWorktree({
      cwd: repoDir,
      worktreePath: created.worktreePath,
      paseoHome,
    });
    expect(existsSync(created.worktreePath)).toBe(false);

    // Second call — nothing left on disk and no admin entry — must not throw.
    await expect(
      deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome }),
    ).resolves.toBeUndefined();
  });

  it("deletes a worktree when the parent repo root is not available", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "no-cwd-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "no-cwd",
      paseoHome,
    });

    const ownership = await isPaseoOwnedWorktreeCwd(created.worktreePath, { paseoHome });
    expect(ownership.allowed).toBe(true);
    expect(ownership.worktreeRoot).toBeTruthy();

    // Simulate the handler path when git has forgotten about the worktree:
    // caller forwards the path-derived worktreesRoot from the ownership check.
    await deletePaseoWorktree({
      cwd: null,
      worktreePath: created.worktreePath,
      worktreesRoot: ownership.worktreeRoot,
      paseoHome,
    });

    expect(existsSync(created.worktreePath)).toBe(false);
  });
});

describe("slugify", () => {
  function expectValidHostnameLabel(label: string): void {
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  }

  it("converts to lowercase kebab-case", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("FOO_BAR")).toBe("foo-bar");
    expect(slugify("My GREAT App")).toBe("my-great-app");
  });

  it("replaces dots with hyphens", () => {
    expect(slugify("my.app")).toBe("my-app");
    expect(slugify("v1.2.3")).toBe("v1-2-3");
  });

  it("collapses multiple consecutive spaces to one hyphen", () => {
    expect(slugify("feature   cool    stuff")).toBe("feature-cool-stuff");
  });

  it("replaces slashes with hyphens", () => {
    expect(slugify("feature/cool stuff")).toBe("feature-cool-stuff");
    expect(slugify("owner/repo")).toBe("owner-repo");
  });

  it("strips unsupported unicode characters", () => {
    expect(slugify("café")).toBe("caf");
    expect(slugify("日本語")).toBe("");
  });

  it("removes leading and trailing punctuation", () => {
    expect(slugify("-foo-")).toBe("foo");
    expect(slugify("__bar__")).toBe("bar");
    expect(slugify(".baz.")).toBe("baz");
  });

  it("truncates long strings at word boundary", () => {
    const longInput =
      "https-stackoverflow-com-questions-68349031-only-run-actions-on-non-draft-pull-request";
    const result = slugify(longInput);
    expect(result.length).toBeLessThanOrEqual(50);
    expectValidHostnameLabel(result);
    expect(result).toBe("https-stackoverflow-com-questions-68349031-only");
  });

  it("truncates without trailing hyphen when no word boundary", () => {
    const longInput = "a".repeat(60);
    const result = slugify(longInput);
    expect(result.length).toBe(50);
    expect(result.endsWith("-")).toBe(false);
    expectValidHostnameLabel(result);
  });

  it("keeps very long names within the hostname label length limit", () => {
    const result = slugify("Beta Build ".repeat(12));

    expect(result.length).toBeLessThanOrEqual(63);
    expectValidHostnameLabel(result);
  });

  it("returns empty when names collapse to empty", () => {
    expect(slugify("---")).toBe("");
    expect(slugify("***")).toBe("");
    expect(slugify("日本語")).toBe("");
  });

  it("is idempotent for representative inputs", () => {
    const inputs = [
      "my.app",
      "feature/cool stuff",
      "  Café Launch  ",
      "__bar__",
      "Beta Build ".repeat(12),
      "release***candidate",
    ];

    for (const input of inputs) {
      const slug = slugify(input);
      expect(slugify(slug)).toBe(slug);
    }
  });
});

describe("resolveWorktreeHolderDir", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-holder-test-")));
    repoDir = join(tempDir, "test-repo");
    paseoHome = join(tempDir, "paseo-home");

    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
      cwd: repoDir,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // The regression bar for the whole refactor: managed must keep producing the
  // exact path the pre-existing builder produced, hash and all.
  it("managed is byte-identical to the pre-existing worktrees root", async () => {
    const expected = await getPaseoWorktreesRoot(repoDir, paseoHome);

    await expect(resolveWorktreeHolderDir({ cwd: repoDir, paseoHome })).resolves.toBe(expected);
    await expect(
      resolveWorktreeHolderDir({ cwd: repoDir, location: { mode: "managed" }, paseoHome }),
    ).resolves.toBe(expected);
    await expect(
      resolveWorktreeHolderDir({ cwd: repoDir, location: null, paseoHome }),
    ).resolves.toBe(expected);
  });

  it("managed honours a custom base root", async () => {
    const worktreesBaseRoot = join(tempDir, "elsewhere");
    const expected = await getPaseoWorktreesRoot(repoDir, paseoHome, worktreesBaseRoot);

    await expect(
      resolveWorktreeHolderDir({
        cwd: repoDir,
        location: { mode: "managed" },
        paseoHome,
        worktreesBaseRoot,
      }),
    ).resolves.toBe(expected);
  });

  it("sibling sits next to the repo", async () => {
    await expect(
      resolveWorktreeHolderDir({ cwd: repoDir, location: { mode: "sibling" }, paseoHome }),
    ).resolves.toBe(join(tempDir, "test-repo-worktrees"));
  });

  it("nested sits inside the repo", async () => {
    await expect(
      resolveWorktreeHolderDir({ cwd: repoDir, location: { mode: "nested" }, paseoHome }),
    ).resolves.toBe(join(repoDir, ".worktrees"));
  });

  // path.basename/dirname already tolerate a trailing separator, so this only
  // pins the behaviour rather than guarding a bug.
  it("sibling tolerates a repo root with a trailing separator", async () => {
    await expect(
      resolveWorktreeHolderDir({
        cwd: repoDir,
        repoRoot: `${repoDir}${sep}`,
        location: { mode: "sibling" },
        paseoHome,
      }),
    ).resolves.toBe(join(tempDir, "test-repo-worktrees"));
  });

  // This is what the resolve() in the sibling branch is actually for: without
  // it a relative repoRoot yields a relative holder, and the worktree lands
  // wherever the daemon's cwd happens to be.
  it("sibling absolutises a relative repo root", async () => {
    const relativeRepoRoot = relative(process.cwd(), repoDir);
    expect(isAbsolute(relativeRepoRoot)).toBe(false);

    await expect(
      resolveWorktreeHolderDir({
        cwd: repoDir,
        repoRoot: relativeRepoRoot,
        location: { mode: "sibling" },
        paseoHome,
      }),
    ).resolves.toBe(join(tempDir, "test-repo-worktrees"));
  });

  it("resolves from a subdirectory of the repo", async () => {
    const nestedCwd = join(repoDir, "packages", "app");
    mkdirSync(nestedCwd, { recursive: true });

    await expect(
      resolveWorktreeHolderDir({ cwd: nestedCwd, location: { mode: "sibling" }, paseoHome }),
    ).resolves.toBe(join(tempDir, "test-repo-worktrees"));
  });

  it("custom expands a tilde and returns an absolute root", async () => {
    const home = process.env.HOME ?? "";
    const result = resolveCustomWorktreeRoot("~/code/worktrees", repoDir);
    expect(result).toEqual({ ok: true, root: join(home, "code", "worktrees") });

    await expect(
      resolveWorktreeHolderDir({
        cwd: repoDir,
        location: { mode: "custom", root: join(tempDir, "custom-holder") },
        paseoHome,
      }),
    ).resolves.toBe(join(tempDir, "custom-holder"));
  });

  it("custom rejects relative, repo-root, inside-repo and containing roots", () => {
    expect(resolveCustomWorktreeRoot("relative/path", repoDir)).toEqual({
      ok: false,
      rejection: "relative",
    });
    expect(resolveCustomWorktreeRoot(repoDir, repoDir)).toEqual({
      ok: false,
      rejection: "is_repo_root",
    });
    // Inside the repo is `nested`, which also writes .git/info/exclude.
    expect(resolveCustomWorktreeRoot(join(repoDir, ".worktrees"), repoDir)).toEqual({
      ok: false,
      rejection: "inside_repo",
    });
    // A slug equal to the repo's own directory name would resolve to the repo.
    expect(resolveCustomWorktreeRoot(tempDir, repoDir)).toEqual({
      ok: false,
      rejection: "contains_repo",
    });
  });

  it("custom rejection surfaces as a thrown error from the resolver", async () => {
    await expect(
      resolveWorktreeHolderDir({
        cwd: repoDir,
        location: { mode: "custom", root: "relative/path" },
        paseoHome,
      }),
    ).rejects.toThrow(/relative/);
  });
});

describe("git-validated worktree deletion", () => {
  let tempDir: string;
  let repoDir: string;
  let holderDir: string;
  let paseoHome: string;

  function git(args: string[], cwd: string): void {
    execFileSync("git", args, { cwd, stdio: "pipe" });
  }

  function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(["init", "-b", "main"], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);
    writeFileSync(join(dir, "file.txt"), "hello\n");
    git(["add", "."], dir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], dir);
  }

  /** A worktree cut outside the managed root, the way sibling/nested/custom do. */
  function addWorktree(slug: string, branch: string): string {
    const path = join(holderDir, slug);
    git(["worktree", "add", path, "-b", branch], repoDir);
    return path;
  }

  function removeGitValidated(worktreePath: string, force?: boolean): Promise<void> {
    return deletePaseoWorktree({
      cwd: repoDir,
      worktreePath,
      teardownCwds: [],
      worktreesRoot: holderDir,
      paseoHome,
      policy: { kind: "git-validated", ...(force === undefined ? {} : { force }) },
    });
  }

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-git-validated-")));
    repoDir = join(tempDir, "test-repo");
    holderDir = join(tempDir, "test-repo-worktrees");
    paseoHome = join(tempDir, "paseo-home");
    initRepo(repoDir);
    mkdirSync(holderDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes a clean worktree", async () => {
    const worktreePath = addWorktree("clean", "clean-branch");
    expect(existsSync(worktreePath)).toBe(true);

    await removeGitValidated(worktreePath);

    expect(existsSync(worktreePath)).toBe(false);
  });

  // The whole point of the policy: a directory nobody registered as a worktree
  // is left alone instead of being recursively deleted.
  it("refuses a plain directory and leaves it on disk", async () => {
    const plainDir = join(holderDir, "not-a-worktree");
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, "important.txt"), "user data\n");

    await expect(removeGitValidated(plainDir)).rejects.toMatchObject({
      name: "WorktreeRemovalRefusedError",
      refusal: "not_a_worktree",
      worktreePath: plainDir,
      recoverableWithForce: false,
    });

    expect(existsSync(join(plainDir, "important.txt"))).toBe(true);
  });

  it("refuses a worktree belonging to another repo and leaves it on disk", async () => {
    const otherRepo = join(tempDir, "other-repo");
    initRepo(otherRepo);
    const foreignWorktree = join(holderDir, "foreign");
    git(["worktree", "add", foreignWorktree, "-b", "foreign-branch"], otherRepo);
    expect(existsSync(join(foreignWorktree, "file.txt"))).toBe(true);

    await expect(removeGitValidated(foreignWorktree)).rejects.toMatchObject({
      refusal: "not_a_worktree",
    });

    expect(existsSync(join(foreignWorktree, "file.txt"))).toBe(true);
  });

  it("refuses a worktree holding uncommitted work, and force overrides", async () => {
    const worktreePath = addWorktree("dirty", "dirty-branch");
    writeFileSync(join(worktreePath, "scratch.txt"), "unsaved work\n");

    await expect(removeGitValidated(worktreePath)).rejects.toMatchObject({
      refusal: "dirty",
      recoverableWithForce: true,
    });
    expect(existsSync(worktreePath)).toBe(true);

    await removeGitValidated(worktreePath, true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  // A lock is a deliberate act by whoever placed it, and git needs `-f -f` to
  // override it. A single --force must not silently defeat it.
  it("refuses a locked worktree even with force", async () => {
    const worktreePath = addWorktree("locked", "locked-branch");
    git(["worktree", "lock", worktreePath], repoDir);

    for (const force of [false, true]) {
      await expect(removeGitValidated(worktreePath, force)).rejects.toMatchObject({
        refusal: "locked",
        recoverableWithForce: false,
      });
      expect(existsSync(worktreePath)).toBe(true);
    }
  });

  // Known, accepted gap: git proves repository membership and cleanliness, not
  // that Paseo created the directory. Asserted so it stays a known gap rather
  // than becoming an unnoticed one.
  it("removes a clean worktree a human created, because git cannot prove authorship", async () => {
    const handMade = join(holderDir, "hand-made");
    git(["worktree", "add", handMade, "-b", "hand-made-branch"], repoDir);

    await removeGitValidated(handMade);

    expect(existsSync(handMade)).toBe(false);
  });

  // Known, accepted gap: ignored files are not protected by git's cleanliness
  // check, so removal destroys them. The UI copy has to say so.
  it("destroys ignored files such as .env without refusing", async () => {
    writeFileSync(join(repoDir, ".gitignore"), ".env\nnode_modules/\n");
    git(["add", "."], repoDir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "ignore"], repoDir);

    const worktreePath = addWorktree("ignored", "ignored-branch");
    writeFileSync(join(worktreePath, ".env"), "SECRET=1\n");
    mkdirSync(join(worktreePath, "node_modules"), { recursive: true });

    await removeGitValidated(worktreePath);

    expect(existsSync(worktreePath)).toBe(false);
  });

  it("requires a cwd so git has a repository to validate against", async () => {
    const worktreePath = addWorktree("no-cwd", "no-cwd-branch");

    await expect(
      deletePaseoWorktree({
        cwd: null,
        worktreePath,
        teardownCwds: [],
        worktreesRoot: holderDir,
        paseoHome,
        policy: { kind: "git-validated" },
      }),
    ).rejects.toThrow(/cwd is required/);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("classifies git's refusal messages", () => {
    expect(classifyWorktreeRemovalRefusal(new Error("fatal: '/x' is not a working tree"))).toBe(
      "not_a_worktree",
    );
    expect(
      classifyWorktreeRemovalRefusal(
        new Error("fatal: '/x' contains modified or untracked files, use --force to delete it"),
      ),
    ).toBe("dirty");
    expect(
      classifyWorktreeRemovalRefusal(new Error("fatal: cannot remove a locked working tree;")),
    ).toBe("locked");
    expect(classifyWorktreeRemovalRefusal(new Error("some other failure"))).toBe("unknown");
  });
});
