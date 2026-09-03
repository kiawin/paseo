import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { KeyedLock, pathLockKey } from "../../utils/keyed-lock.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";

/**
 * Orders every operation that either removes a backing directory or registers a
 * workspace record against one.
 *
 * Archive decides whether a directory is still referenced by listing the active
 * workspaces, then removes it. Provisioning writes the record that would make it
 * referenced. Without a shared lock those interleave: archive reads an empty
 * reference set, provisioning registers a workspace, archive deletes the
 * directory out from under it. Both sides take this lock on the same path, so
 * one of the two orderings always holds — archive sees the new record and
 * declines, or provisioning finds the directory already gone and refuses to
 * register a record pointing at nothing.
 *
 * In-process only, like the KeyedLock it wraps. It says nothing about two
 * daemons sharing one PASEO_HOME.
 */
const backingDirectoryLock = new KeyedLock();

/** Runs `operation` with exclusive claim on `path` as a backing directory. */
export function withWorkspaceBackingDirectory<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  return backingDirectoryLock.run(pathLockKey(path), operation);
}

/**
 * The directory whose lifetime a workspace record depends on.
 *
 * Must agree with resolveWorkspaceBackingDirectory in the archive service, which
 * derives the same path for records that carry their placement. Archive also has
 * a filesystem-discovery fallback for records written before v0.1.110; that
 * cannot apply here because provisioning only ever hands this newly built
 * records, which always carry worktreeRoot and mainRepoRoot.
 */
export function workspaceBackingPath(
  workspace: Pick<PersistedWorkspaceRecord, "isPaseoOwnedWorktree" | "worktreeRoot" | "cwd">,
): string {
  return resolve(
    workspace.isPaseoOwnedWorktree && workspace.worktreeRoot
      ? workspace.worktreeRoot
      : workspace.cwd,
  );
}

/** True when `path` is present as a directory. */
export async function backingDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
