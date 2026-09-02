import { areEquivalentPaths, getRealpathAwareRelativePath } from "../../utils/path.js";
import {
  resolvePaseoWorktreesBaseRoot,
  type WorktreeDeletionPolicy,
  type WorktreeRootOptions,
} from "../../utils/worktree.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { WorktreeLocation } from "@getpaseo/protocol/messages";

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
 * `managed` — the forced, unconditional recursive delete — requires the
 * persisted placement and the path to agree. Neither is sufficient alone.
 *
 * The path alone is not, because outside Paseo's private root it proves
 * nothing. The persisted value alone is not, because zod strips unknown keys
 * and the registry re-parses records on every mutation, so a daemon predating
 * the field erases it — and because nothing re-checks the value after creation.
 * Any disagreement, in either direction, resolves to `git-validated`.
 *
 * `force` is only ever set from an explicit second confirmation by a person.
 */
export function resolveWorktreeDeletionPolicy(input: {
  workspace: Pick<PersistedWorkspaceRecord, "worktreePlacement" | "worktreeRoot" | "cwd">;
  force?: boolean;
  options?: WorktreeRootOptions;
}): WorktreeDeletionPolicy {
  const byPath = classifyWorktreePlacementByPath(
    input.workspace.worktreeRoot ?? input.workspace.cwd,
    input.options,
  );

  // Both have to agree before the destructive policy applies. The persisted
  // value alone is not enough: it is written once at creation and nothing
  // re-checks it afterwards, so a worktree that moved, a hand-edited registry,
  // or any future bug writing "managed" would otherwise aim the forced
  // recursive delete at a shared directory. Disagreement falls to the policy
  // that cannot destroy anything git has not vouched for.
  const persisted = input.workspace.worktreePlacement;
  if (byPath === "managed" && (persisted ?? "managed") === "managed") {
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

/**
 * Where the project owning `repoRoot` cuts worktrees.
 *
 * Keyed by repo root rather than projectId because callers such as worktree
 * listing and MCP entry points only have a path. An unknown repository resolves
 * to null, which means the managed layout.
 */
export async function resolveProjectWorktreeLocation(
  projectRegistry: { list: () => Promise<PersistedProjectRecord[]> },
  repoRoot: string,
): Promise<WorktreeLocation | null> {
  try {
    const projects = await projectRegistry.list();
    const match = projects.find(
      (project) => !project.archivedAt && areEquivalentPaths(project.rootPath, repoRoot),
    );
    return match?.worktreeLocation ?? null;
  } catch {
    return null;
  }
}
