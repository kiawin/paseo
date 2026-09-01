import { getRealpathAwareRelativePath } from "../../utils/path.js";
import {
  resolvePaseoWorktreesBaseRoot,
  type WorktreeDeletionPolicy,
  type WorktreeRootOptions,
} from "../../utils/worktree.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";

/**
 * Where a Paseo-created worktree lives, which decides how its directory may be
 * removed.
 *
 * `managed` is inside `<base>/<hash8>/`, a namespace nothing else writes to, so
 * the forced recursive delete is safe there. `external` is a directory people
 * also keep their own worktrees in, so removal has to go through git.
 */
export type WorktreePlacement = "managed" | "external";

/**
 * Classifies a worktree by its path.
 *
 * Path shape decides only the `managed` case. That is the direction where it is
 * sound proof — the two-level `<hash>/<slug>` prefix under Paseo's base root is
 * private — and it is also the safe direction to be wrong in: anything the
 * check does not recognise falls to `external`, whose removal git validates.
 */
export function classifyWorktreePlacementByPath(
  worktreePath: string,
  options?: WorktreeRootOptions,
): WorktreePlacement {
  const baseRoot = resolvePaseoWorktreesBaseRoot(options);
  const relativePath = getRealpathAwareRelativePath(baseRoot, worktreePath);
  if (relativePath === null) {
    return "external";
  }

  const segments = relativePath.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.length >= 2 ? "managed" : "external";
}

/**
 * The deletion policy for a workspace's worktree.
 *
 * The persisted placement wins when present, but it cannot be the sole
 * authority: zod strips unknown keys and the registry re-parses records on every
 * mutation, so a daemon predating the field erases it. Absence therefore falls
 * back to the path rather than defaulting to `managed`, which would let a
 * downgrade round-trip point the forced recursive delete at a shared directory.
 *
 * `force` is only ever set from an explicit second confirmation by a person.
 */
export function resolveWorktreeDeletionPolicy(input: {
  workspace: Pick<PersistedWorkspaceRecord, "worktreePlacement" | "worktreeRoot" | "cwd">;
  force?: boolean;
  options?: WorktreeRootOptions;
}): WorktreeDeletionPolicy {
  const placement =
    input.workspace.worktreePlacement ??
    classifyWorktreePlacementByPath(
      input.workspace.worktreeRoot ?? input.workspace.cwd,
      input.options,
    );

  if (placement === "managed") {
    return { kind: "managed" };
  }
  return { kind: "git-validated", ...(input.force === true ? { force: true } : {}) };
}

/**
 * Whether Paseo created this workspace, which gates lifecycle actions such as
 * auto-archive and teardown.
 *
 * Deliberately separate from whether Paseo may delete the directory. Getting
 * this wrong archives a record, which is reversible; getting deletion wrong is
 * not. The persisted record is authoritative — a missing or unreadable marker
 * must not disable auto-archive for a workspace Paseo is recorded as creating.
 */
export function isPaseoCreatedWorkspace(
  workspace: Pick<PersistedWorkspaceRecord, "kind" | "isPaseoOwnedWorktree">,
): boolean {
  return workspace.kind === "worktree" && workspace.isPaseoOwnedWorktree;
}
