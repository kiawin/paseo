import { describe, expect, test } from "vitest";
import { isAbsolute } from "node:path";

import {
  checkoutFromPersistedWorkspacePlacement,
  deriveWorkspaceKind,
  generateWorkspaceId,
  generateProjectId,
  initialWorkspacePlacement,
  reconcileWorkspacePlacement,
} from "./workspace-registry-model.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

describe("opaque registry ids", () => {
  test("generates opaque project ids", () => {
    expect(generateProjectId()).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  test("generates opaque workspace ids that are not filesystem paths", () => {
    const workspaceId = generateWorkspaceId();

    expect(workspaceId).toMatch(/^wks_[0-9a-f]+$/);
    expect(isAbsolute(workspaceId)).toBe(false);
  });
});

describe("workspace kind", () => {
  test("classifies plain git worktrees as workspaces of kind worktree", () => {
    expect(
      deriveWorkspaceKind({
        cwd: "/tmp/repo-feature",
        isGit: true,
        currentBranch: "feature/plain",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: "/tmp/repo-feature",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/tmp/repo",
      }),
    ).toBe("worktree");
  });
});

describe("workspace placement", () => {
  test("defines checkout and created-worktree placement completely", () => {
    expect(
      initialWorkspacePlacement({
        source: "checkout",
        cwd: "/repo",
        checkout: {
          cwd: "/repo",
          isGit: true,
          currentBranch: " main ",
          remoteUrl: null,
          worktreeRoot: "/repo",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      }),
    ).toEqual({
      cwd: "/repo",
      kind: "local_checkout",
      displayName: "main",
      branch: "main",
      worktreeRoot: "/repo",
      baseBranch: null,
      isPaseoOwnedWorktree: false,
      worktreePlacement: null,
      mainRepoRoot: null,
    });
    expect(
      initialWorkspacePlacement({
        source: "created_worktree",
        cwd: "/repo-feature/app",
        worktreeRoot: "/repo-feature",
        branch: "feature/placement",
        baseBranch: "main",
        mainRepoRoot: "/repo",
      }),
    ).toEqual({
      cwd: "/repo-feature/app",
      kind: "worktree",
      displayName: "feature/placement",
      branch: "feature/placement",
      worktreeRoot: "/repo-feature",
      baseBranch: "main",
      isPaseoOwnedWorktree: true,
      mainRepoRoot: "/repo",
    });
  });

  test("updates live placement while preserving its durable name and base branch", () => {
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "workspace-one",
      projectId: "project-one",
      cwd: "/repo-feature",
      kind: "worktree",
      displayName: "Keep this name",
      branch: "old-branch",
      worktreeRoot: "/old-root",
      baseBranch: "release",
      isPaseoOwnedWorktree: true,
      mainRepoRoot: "/repo",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    const update = reconcileWorkspacePlacement({
      workspace,
      checkout: {
        cwd: workspace.cwd,
        isGit: true,
        currentBranch: "renamed-branch",
        remoteUrl: null,
        worktreeRoot: "/repo-feature",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/repo",
      },
      updatedAt: "2026-03-02T00:00:00.000Z",
    });

    // isPaseoOwnedWorktree is deliberately absent: the checkout reports false
    // because the path-based check only recognises Paseo's private root, and
    // reconcile must not withdraw creation-time provenance on that basis.
    expect(update?.fields).toEqual({
      branch: "renamed-branch",
      worktreeRoot: "/repo-feature",
    });
    expect(update?.workspace).toMatchObject({
      displayName: "Keep this name",
      baseBranch: "release",
      branch: "renamed-branch",
    });
  });

  test("projects persisted placement to the wire checkout", () => {
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "workspace-one",
      projectId: "project-one",
      cwd: "/repo-feature/app",
      kind: "worktree",
      displayName: "feature",
      branch: "feature",
      worktreeRoot: "/repo-feature",
      isPaseoOwnedWorktree: true,
      mainRepoRoot: "/repo",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    expect(checkoutFromPersistedWorkspacePlacement({ workspace })).toEqual({
      cwd: "/repo-feature/app",
      isGit: true,
      currentBranch: "feature",
      remoteUrl: null,
      worktreeRoot: "/repo-feature",
      isPaseoOwnedWorktree: true,
      mainRepoRoot: "/repo",
    });
  });
});

const baseWorkspace = createPersistedWorkspaceRecord({
  workspaceId: "wks_provenance",
  projectId: "prj_provenance",
  cwd: "/home/dev/repo-worktrees/feat",
  kind: "worktree",
  displayName: "feat",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
});

describe("reconcile and creation-time provenance", () => {
  // Regression: `observed` derives isPaseoOwnedWorktree from path shape, which
  // only recognises Paseo's private root. Reconcile runs at boot, on watcher
  // events, on unarchive and on every agent create — so downgrading here would
  // strip provenance from every worktree cut into a sibling, nested or custom
  // holder, taking auto-archive, teardown and any route to removal with it.
  test("never withdraws isPaseoOwnedWorktree from a record that has it", () => {
    const workspace = {
      ...baseWorkspace,
      kind: "worktree" as const,
      cwd: "/home/dev/repo-worktrees/feat",
      worktreeRoot: "/home/dev/repo-worktrees/feat",
      isPaseoOwnedWorktree: true,
      mainRepoRoot: "/home/dev/repo",
    };

    const update = reconcileWorkspacePlacement({
      workspace,
      checkout: {
        isGit: true,
        currentBranch: "feat",
        worktreeRoot: "/home/dev/repo-worktrees/feat",
        mainRepoRoot: "/home/dev/repo",
        // What the path-based check reports for a holder outside the base root.
        isPaseoOwnedWorktree: false,
      },
      updatedAt: "2026-09-02T00:00:00.000Z",
    });

    expect(update?.fields.isPaseoOwnedWorktree).toBeUndefined();
    expect(update?.workspace.isPaseoOwnedWorktree ?? true).toBe(true);
  });

  test("still adopts ownership when the record lacks it", () => {
    const update = reconcileWorkspacePlacement({
      workspace: { ...baseWorkspace, kind: "worktree" as const, isPaseoOwnedWorktree: false },
      checkout: {
        isGit: true,
        currentBranch: null,
        worktreeRoot: baseWorkspace.cwd,
        mainRepoRoot: "/home/dev/repo",
        isPaseoOwnedWorktree: true,
      },
      updatedAt: "2026-09-02T00:00:00.000Z",
    });

    expect(update?.fields.isPaseoOwnedWorktree).toBe(true);
  });
});
