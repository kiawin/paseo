import { describe, expect, test } from "vitest";

import { withWorkspaceBackingDirectory, workspaceBackingPath } from "./backing-directory.js";

/**
 * Archive and provisioning live in different modules and must contend on one
 * lock. A second instance would look identical at every call site and protect
 * nothing, so these exercise exclusion through the module's public entry point.
 */
describe("withWorkspaceBackingDirectory", () => {
  test("serializes separate calls that name the same directory", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstEntered = withDeferred();
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withWorkspaceBackingDirectory("/repo-worktrees/feat-x", async () => {
      order.push("first:enter");
      firstEntered.resolve();
      await firstHeld;
      order.push("first:exit");
    });

    await firstEntered.promise;
    const second = withWorkspaceBackingDirectory("/repo-worktrees/feat-x", async () => {
      order.push("second:enter");
    });

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:enter", "first:exit", "second:enter"]);
  });

  test("keeps different directories independent", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstEntered = withDeferred();
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withWorkspaceBackingDirectory("/repo-worktrees/feat-x", async () => {
      firstEntered.resolve();
      await firstHeld;
      order.push("first:exit");
    });

    await firstEntered.promise;
    // Held only by the other key, so this must not wait on it.
    await withWorkspaceBackingDirectory("/repo-worktrees/feat-y", async () => {
      order.push("other:done");
    });

    releaseFirst();
    await first;

    expect(order).toEqual(["other:done", "first:exit"]);
  });

  test("releases the key when the held operation throws", async () => {
    const key = "/repo-worktrees/feat-x";
    await expect(
      withWorkspaceBackingDirectory(key, async () => {
        throw new Error("archive failed");
      }),
    ).rejects.toThrow("archive failed");

    await expect(withWorkspaceBackingDirectory(key, async () => "next")).resolves.toBe("next");
  });
});

describe("workspaceBackingPath", () => {
  // Must agree with resolveWorkspaceBackingDirectory in the archive service, or
  // the two sides lock different keys and neither excludes the other.
  test("uses the worktree root for a Paseo-owned worktree", () => {
    expect(
      workspaceBackingPath({
        isPaseoOwnedWorktree: true,
        worktreeRoot: "/repo-worktrees/feat-x",
        cwd: "/repo-worktrees/feat-x/packages/app",
      }),
    ).toBe("/repo-worktrees/feat-x");
  });

  test("falls back to the cwd when Paseo does not own the worktree", () => {
    expect(
      workspaceBackingPath({
        isPaseoOwnedWorktree: false,
        worktreeRoot: "/somewhere/else",
        cwd: "/repo",
      }),
    ).toBe("/repo");
  });

  test("falls back to the cwd when an owned record has no worktree root", () => {
    expect(
      workspaceBackingPath({ isPaseoOwnedWorktree: true, worktreeRoot: null, cwd: "/repo" }),
    ).toBe("/repo");
  });
});

function withDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
