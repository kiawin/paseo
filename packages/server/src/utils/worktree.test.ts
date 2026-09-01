import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createWorktree as createWorktreePrimitive,
  deriveWorktreeProjectHash,
  deletePaseoWorktree,
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
