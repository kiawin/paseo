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

/** `canceled`: an undo stopped this archive before it finished. */
export type WorkspaceArchiveOutcome = "archived" | "canceled";

export interface ArchiveWorkspaceResponse {
  error: string | null;
  canceled?: boolean;
  worktreeDirectoryRemoved?: boolean | null;
  worktreeRemovalRefusal?: WorktreeRemovalRefusal | null;
}

export interface OptimisticWorkspaceArchive {
  /** The row as it was before the archive hid it, for undo to put back. */
  hidden: WorkspaceDescriptor | null;
  done: Promise<WorkspaceArchiveOutcome>;
  response: Promise<ArchiveWorkspaceResponse | null>;
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
  if (payload.canceled) {
    return payload;
  }
  if (payload.error) {
    throw new Error(payload.error);
  }
  return payload;
}

/**
 * Hides the row now and archives it on the host. A failed or canceled archive puts the row back.
 */
export function beginOptimisticWorkspaceArchive(input: {
  client: WorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
  removeWorktreeDirectory?: boolean;
}): OptimisticWorkspaceArchive {
  const snapshot = hideWorkspaceOptimistically(input.workspace);
  const operation = (async () => {
    try {
      const response = await archiveWorkspaceOrThrow({
        client: input.client,
        workspaceId: input.workspace.workspaceId,
        ...(input.removeWorktreeDirectory === true ? { removeWorktreeDirectory: true } : {}),
      });
      if (response.canceled) {
        restoreOptimisticallyHiddenWorkspace({ serverId: input.workspace.serverId, snapshot });
        return { outcome: "canceled" as const, response };
      }
      return { outcome: "archived" as const, response };
    } catch (error) {
      restoreOptimisticallyHiddenWorkspace({ serverId: input.workspace.serverId, snapshot });
      throw error;
    }
  })();
  return {
    hidden: snapshot.workspace,
    done: operation.then(({ outcome }) => outcome),
    response: operation.then(
      ({ response }) => response,
      () => null,
    ),
  };
}

export async function archiveWorkspaceOptimistically(input: {
  client: WorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
  removeWorktreeDirectory?: boolean;
}): Promise<ArchiveWorkspaceResponse | null> {
  const archive = beginOptimisticWorkspaceArchive(input);
  const [outcome, response] = await Promise.all([archive.done, archive.response]);
  return outcome === "canceled" ? null : response;
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
