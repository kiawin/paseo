import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  isWorkspaceArchiveIntentCurrent,
  markWorkspaceArchivePending,
  markWorkspaceArchiveUndoPending,
  settleWorkspaceArchiveIntent,
  type WorkspaceArchiveIntent,
} from "@/contexts/session-workspace-upserts";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { i18n } from "@/i18n/i18next";
import type { WorktreeRemovalRefusal } from "@getpaseo/protocol/messages";

export interface WorkspaceArchiveTarget {
  serverId: string;
  workspaceId: string;
}

interface WorkspaceArchiveClient {
  archiveWorkspace: (
    workspaceId: string,
    options?: { removeWorktreeDirectory?: boolean },
  ) => Promise<ArchiveWorkspaceResponse>;
}

interface WorkspaceArchiveUndoClient {
  undoWorkspaceArchive: (workspaceId: string) => Promise<void>;
}

/** `canceled`: an undo stopped the archive on the host before it finished. */
export type WorkspaceArchiveOutcome = "archived" | "canceled";

export interface OptimisticWorkspaceArchive {
  /** The row as it was before the archive hid it, for undo to put back. */
  hidden: WorkspaceDescriptor | null;
  done: Promise<WorkspaceArchiveOutcome>;
  response: Promise<ArchiveWorkspaceResponse>;
}

/** What the daemon did; worktree fields are absent on older daemons. */
export interface ArchiveWorkspaceResponse {
  error: string | null;
  canceled?: boolean;
  worktreeDirectoryRemoved?: boolean | null;
  worktreeRemovalRefusal?: WorktreeRemovalRefusal | null;
}

interface OptimisticWorkspaceArchiveSnapshot {
  workspace: WorkspaceDescriptor | null;
  intent: WorkspaceArchiveIntent;
}

export interface WorkspaceArchiveFailure {
  serverId: string;
  workspaceId: string;
  error: unknown;
}

function isWorkspaceArchiveFailure(error: unknown): error is WorkspaceArchiveFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "serverId" in error &&
    typeof error.serverId === "string" &&
    "workspaceId" in error &&
    typeof error.workspaceId === "string" &&
    "error" in error
  );
}

function findListedWorkspace(workspace: WorkspaceArchiveTarget): WorkspaceDescriptor | null {
  const workspaces = useSessionStore.getState().sessions[workspace.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: workspace.workspaceId,
  });
  return workspaceKey ? (workspaces?.get(workspaceKey) ?? null) : null;
}

/** True when the workspace is in this client's list, for example after another client restored it. */
export function isWorkspaceListed(workspace: WorkspaceArchiveTarget): boolean {
  return findListedWorkspace(workspace) !== null;
}

function hideWorkspaceOptimistically(
  workspace: WorkspaceArchiveTarget,
): OptimisticWorkspaceArchiveSnapshot {
  const snapshot = findListedWorkspace(workspace);
  const intent = markWorkspaceArchivePending({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  });
  getHostRuntimeStore().removeWorkspaceSnapshot(workspace.serverId, workspace.workspaceId);
  return { workspace: snapshot, intent };
}

/**
 * Puts back a row whose archive did not happen. Skipped when a newer request on this client
 * (an undo, or another archive) owns the row by now.
 */
function restoreOptimisticallyHiddenWorkspace(input: {
  serverId: string;
  snapshot: OptimisticWorkspaceArchiveSnapshot;
}): void {
  if (!isWorkspaceArchiveIntentCurrent(input.snapshot.intent)) return;
  settleWorkspaceArchiveIntent(input.snapshot.intent);
  if (input.snapshot.workspace) {
    getHostRuntimeStore().acceptWorkspaceSnapshots(input.serverId, [input.snapshot.workspace]);
  }
}

async function archiveWorkspaceOrThrow(input: {
  client: WorkspaceArchiveClient;
  workspaceId: string;
  removeWorktreeDirectory?: boolean;
}): Promise<ArchiveWorkspaceResponse> {
  const payload = await input.client.archiveWorkspace(
    input.workspaceId,
    input.removeWorktreeDirectory === true ? { removeWorktreeDirectory: true } : undefined,
  );
  if (payload.error) {
    if (payload.canceled) return payload;
    throw new Error(payload.error);
  }
  return payload;
}

/**
 * Hides the row now and archives it on the host. A failed archive puts the row back, and so
 * does a canceled one: an undo from another client stopped it, so the workspace stays.
 */
export function beginOptimisticWorkspaceArchive(input: {
  client: WorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
  removeWorktreeDirectory?: boolean;
}): OptimisticWorkspaceArchive {
  const snapshot = hideWorkspaceOptimistically(input.workspace);
  const response = (async () => {
    try {
      const result = await archiveWorkspaceOrThrow({
        client: input.client,
        workspaceId: input.workspace.workspaceId,
        ...(input.removeWorktreeDirectory === true ? { removeWorktreeDirectory: true } : {}),
      });
      if (result.canceled) {
        restoreOptimisticallyHiddenWorkspace({ serverId: input.workspace.serverId, snapshot });
      }
      return result;
    } catch (error) {
      restoreOptimisticallyHiddenWorkspace({ serverId: input.workspace.serverId, snapshot });
      throw error;
    }
  })();
  const done = response.then((result) => (result.canceled ? "canceled" : "archived"));
  // Direct archive callers observe `response`; an undo window is the only consumer of `done`.
  // Handle an unused rejection while leaving `done` rejected for callers that await it.
  void done.catch(() => {});
  return { hidden: snapshot.workspace, done, response };
}

export async function archiveWorkspaceOptimistically(input: {
  client: WorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
  removeWorktreeDirectory?: boolean;
}): Promise<ArchiveWorkspaceResponse> {
  return beginOptimisticWorkspaceArchive(input).response;
}

/**
 * Puts the archived row back now and asks the host to undo the archive, whether it is still
 * running or already finished. A failed undo hides the row again, unless the user archived
 * it again in the meantime.
 */
export async function undoWorkspaceArchiveOptimistically(input: {
  client: WorkspaceArchiveUndoClient;
  workspace: WorkspaceArchiveTarget;
  hidden: WorkspaceDescriptor | null;
}): Promise<void> {
  const { serverId, workspaceId } = input.workspace;
  const intent = markWorkspaceArchiveUndoPending({ serverId, workspaceId });
  if (input.hidden) {
    getHostRuntimeStore().acceptWorkspaceSnapshots(serverId, [input.hidden]);
  }
  try {
    await input.client.undoWorkspaceArchive(workspaceId);
  } catch (error) {
    if (isWorkspaceArchiveIntentCurrent(intent)) {
      getHostRuntimeStore().removeWorkspaceSnapshot(serverId, workspaceId);
    }
    throw error;
  } finally {
    settleWorkspaceArchiveIntent(intent);
  }
}

export async function archiveWorkspacesOptimistically(input: {
  getClient: (serverId: string) => WorkspaceArchiveClient | null;
  workspaces: WorkspaceArchiveTarget[];
}): Promise<WorkspaceArchiveFailure[]> {
  const results = await Promise.allSettled(
    input.workspaces.map(async (workspace) => {
      const client = input.getClient(workspace.serverId);
      if (!client) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error: new Error(i18n.t("sidebar.workspace.toasts.hostDisconnected")),
        } satisfies WorkspaceArchiveFailure;
      }

      try {
        await archiveWorkspaceOptimistically({
          client,
          workspace,
        });
      } catch (error) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error,
        } satisfies WorkspaceArchiveFailure;
      }
    }),
  );

  return results.flatMap((result) =>
    result.status === "rejected" && isWorkspaceArchiveFailure(result.reason) ? [result.reason] : [],
  );
}
