import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { describeWorktreeRemoval } from "./describe-worktree-removal";

const t = ((key: string) => key) as unknown as TFunction;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    workspaceId: "ws-1",
    removed: false,
    worktreePath: null,
    refusal: null,
    recoverableWithForce: false,
    error: null,
    ...overrides,
  } as Parameters<typeof describeWorktreeRemoval>[0]["result"];
}

describe("describeWorktreeRemoval", () => {
  it("reports success", () => {
    expect(
      describeWorktreeRemoval({
        result: payload({ removed: true }),
        fallbackPath: "/home/dev/repo-worktrees/feat",
        t,
      }),
    ).toEqual({ message: "workspace.route.recovery.removeWorktreeDone", variant: "success" });
  });

  // Terminal: git has disowned the directory, so no force level recovers it.
  // The only useful thing left is the path, so it must be in the message.
  it("hands over the path when git no longer recognises the directory", () => {
    const outcome = describeWorktreeRemoval({
      result: payload({
        refusal: "not_a_worktree",
        worktreePath: "/home/dev/repo-worktrees/feat",
      }),
      fallbackPath: "/unused",
      t,
    });

    expect(outcome.variant).toBe("error");
    expect(outcome.message).toContain("/home/dev/repo-worktrees/feat");
  });

  it("falls back to the known path when the response omits one", () => {
    const outcome = describeWorktreeRemoval({
      result: payload({ refusal: "not_a_worktree" }),
      fallbackPath: "/home/dev/repo-worktrees/feat",
      t,
    });

    expect(outcome.message).toContain("/home/dev/repo-worktrees/feat");
  });

  // Recoverable refusals already carry git's own reason, which is more useful
  // than anything generic we could substitute.
  it("surfaces git's message for a refusal that force could clear", () => {
    expect(
      describeWorktreeRemoval({
        result: payload({
          refusal: "dirty",
          recoverableWithForce: true,
          error: "contains modified or untracked files",
        }),
        fallbackPath: "/unused",
        t,
      }),
    ).toEqual({ message: "contains modified or untracked files", variant: "error" });
  });

  it("falls back to generic copy when no reason was given", () => {
    expect(
      describeWorktreeRemoval({ result: payload({ refusal: "unknown" }), fallbackPath: "/x", t })
        .message,
    ).toBe("workspace.route.recovery.removeWorktreeRefused");
  });
});
