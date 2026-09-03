import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  classifyWorktreePlacementByPath,
  isPaseoCreatedWorkspace,
  resolveWorktreeDeletionPolicy,
} from "./ownership.js";

const PASEO_HOME = "/tmp/paseo-home";
const MANAGED_BASE = join(PASEO_HOME, "worktrees");

describe("classifyWorktreePlacementByPath", () => {
  it("recognises the two-level managed layout", () => {
    expect(
      classifyWorktreePlacementByPath(join(MANAGED_BASE, "a1b2c3d4", "feat"), {
        paseoHome: PASEO_HOME,
      }),
    ).toBe("managed");
  });

  it("treats the base root and a bare hash directory as external", () => {
    // Neither is a worktree, and neither carries the <hash>/<slug> proof.
    expect(classifyWorktreePlacementByPath(MANAGED_BASE, { paseoHome: PASEO_HOME })).toBe(
      "external",
    );
    expect(
      classifyWorktreePlacementByPath(join(MANAGED_BASE, "a1b2c3d4"), { paseoHome: PASEO_HOME }),
    ).toBe("external");
  });

  it("treats sibling, nested and custom holders as external", () => {
    for (const path of [
      "/home/dev/repo-worktrees/feat",
      "/home/dev/repo/.worktrees/feat",
      "/home/dev/elsewhere/feat",
    ]) {
      expect(classifyWorktreePlacementByPath(path, { paseoHome: PASEO_HOME })).toBe("external");
    }
  });

  it("honours a custom worktrees root with no 'worktrees' segment", () => {
    expect(
      classifyWorktreePlacementByPath("/srv/pw/a1b2c3d4/feat", { worktreesRoot: "/srv/pw" }),
    ).toBe("managed");
  });
});

describe("resolveWorktreeDeletionPolicy", () => {
  const options = { paseoHome: PASEO_HOME };

  it("requires the persisted placement and the path to agree before destroying", () => {
    // A persisted "managed" on an external path must NOT authorize the forced
    // recursive delete. Nothing re-checks the field after creation, so a moved
    // worktree or a hand-edited registry would otherwise aim it at a shared
    // directory.
    expect(
      resolveWorktreeDeletionPolicy({
        workspace: {
          worktreePlacement: "managed",
          worktreeRoot: "/home/dev/repo-worktrees/feat",
          cwd: "/home/dev/repo-worktrees/feat",
        },
        options,
      }),
    ).toEqual({ kind: "git-validated" });

    expect(
      resolveWorktreeDeletionPolicy({
        workspace: {
          worktreePlacement: "managed",
          worktreeRoot: join(MANAGED_BASE, "a1b2c3d4", "feat"),
          cwd: join(MANAGED_BASE, "a1b2c3d4", "feat"),
        },
        options,
      }),
    ).toEqual({ kind: "managed" });

    expect(
      resolveWorktreeDeletionPolicy({
        workspace: {
          worktreePlacement: "external",
          worktreeRoot: join(MANAGED_BASE, "a1b2c3d4", "feat"),
          cwd: join(MANAGED_BASE, "a1b2c3d4", "feat"),
        },
        options,
      }),
    ).toEqual({ kind: "git-validated" });
  });

  // The rollout hazard: zod strips unknown keys, so a daemon predating the field
  // erases it. Absence must fall back to the path, never default to managed.
  it("falls back to the path when the placement was stripped", () => {
    expect(
      resolveWorktreeDeletionPolicy({
        workspace: {
          worktreePlacement: null,
          worktreeRoot: join(MANAGED_BASE, "a1b2c3d4", "feat"),
          cwd: join(MANAGED_BASE, "a1b2c3d4", "feat"),
        },
        options,
      }),
    ).toEqual({ kind: "managed" });

    expect(
      resolveWorktreeDeletionPolicy({
        workspace: {
          worktreePlacement: null,
          worktreeRoot: "/home/dev/repo-worktrees/feat",
          cwd: "/home/dev/repo-worktrees/feat",
        },
        options,
      }),
    ).toEqual({ kind: "git-validated" });
  });

  it("only sets force when explicitly asked", () => {
    const workspace = {
      worktreePlacement: "external" as const,
      worktreeRoot: "/home/dev/repo-worktrees/feat",
      cwd: "/home/dev/repo-worktrees/feat",
    };

    expect(resolveWorktreeDeletionPolicy({ workspace, options })).toEqual({
      kind: "git-validated",
    });
    expect(resolveWorktreeDeletionPolicy({ workspace, force: false, options })).toEqual({
      kind: "git-validated",
    });
    expect(resolveWorktreeDeletionPolicy({ workspace, force: true, options })).toEqual({
      kind: "git-validated",
      force: true,
    });
  });

  // Force is meaningless for managed, which already forces unconditionally.
  it("ignores force for a managed worktree", () => {
    expect(
      resolveWorktreeDeletionPolicy({
        workspace: {
          worktreePlacement: "managed",
          worktreeRoot: join(MANAGED_BASE, "a1b2c3d4", "feat"),
          cwd: join(MANAGED_BASE, "a1b2c3d4", "feat"),
        },
        force: true,
        options,
      }),
    ).toEqual({ kind: "managed" });
  });
});

describe("isPaseoCreatedWorkspace", () => {
  it("requires both a worktree kind and the persisted flag", () => {
    expect(isPaseoCreatedWorkspace({ kind: "worktree", isPaseoOwnedWorktree: true })).toBe(true);
    expect(isPaseoCreatedWorkspace({ kind: "worktree", isPaseoOwnedWorktree: false })).toBe(false);
    expect(isPaseoCreatedWorkspace({ kind: "local_checkout", isPaseoOwnedWorktree: true })).toBe(
      false,
    );
    expect(isPaseoCreatedWorkspace({ kind: "directory", isPaseoOwnedWorktree: false })).toBe(false);
  });
});
