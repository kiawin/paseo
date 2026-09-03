import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import {
  confirmRiskyWorktreeArchive,
  DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
  type WorktreeArchiveWarningLabels,
} from "@/git/worktree-archive-warning";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { WorktreeRemovalRefusal } from "@getpaseo/protocol/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { archiveWorkspaceOptimistically } from "@/workspace/workspace-archive";

function purgeArchivedWorkspaceState(input: { serverId: string; workspaceId: string }): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (workspaceKey) {
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
  }
}

export interface ArchiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  isDirty?: boolean | null;
  aheadOfOrigin?: number | null;
  diffStat?: { additions: number; deletions: number } | null;
  warningLabels?: WorktreeArchiveWarningLabels;
  onArchiveStarted: () => void;
  onSetHiding?: (hiding: boolean) => void;
}

export interface WorkspaceArchiveController {
  archive: () => void;
  /**
   * Archive, and delete the worktree directory with it.
   *
   * Archive on its own leaves a worktree cut outside Paseo's managed root
   * alone, so this is the only way to ask for the directory from the sidebar.
   */
  deleteWithWorktree: () => void;
}

/**
 * Git kept the directory. The workspace is archived either way, so this is the
 * only moment the person hears about it.
 */
function keptWorktreeReasonKey(refusal: WorktreeRemovalRefusal | null | undefined): string {
  switch (refusal) {
    case "dirty":
      return "sidebar.workspace.toasts.worktreeKeptDirty";
    case "locked":
      return "sidebar.workspace.toasts.worktreeKeptLocked";
    case "not_a_worktree":
      return "sidebar.workspace.toasts.worktreeKeptUnrecognised";
    default:
      return "sidebar.workspace.toasts.worktreeKeptUnknown";
  }
}

export function useWorkspaceArchive(input: ArchiveWorkspaceInput): WorkspaceArchiveController {
  const {
    serverId,
    workspaceId,
    workspaceKind,
    name,
    isDirty,
    aheadOfOrigin,
    diffStat,
    warningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
    onArchiveStarted,
    onSetHiding,
  } = input;
  const { t } = useTranslation();
  const toast = useToast();

  const archiveWorkspaceRecord = useCallback(
    async (options?: { removeWorktreeDirectory?: boolean }) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
        return;
      }
      onSetHiding?.(true);
      try {
        onArchiveStarted();
        const outcome = await archiveWorkspaceOptimistically({
          client,
          workspace: {
            serverId,
            workspaceId,
          },
          ...(options?.removeWorktreeDirectory === true ? { removeWorktreeDirectory: true } : {}),
        });
        purgeArchivedWorkspaceState({ serverId, workspaceId });
        // Only false means the removal was tried and did not happen. Null is a
        // workspace with no directory Paseo may delete, or a host predating the
        // field, and neither is something to report.
        if (outcome.worktreeDirectoryRemoved === false) {
          toast.error(t(keptWorktreeReasonKey(outcome.worktreeRemovalRefusal)));
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
        );
      } finally {
        onSetHiding?.(false);
      }
    },
    [onArchiveStarted, onSetHiding, serverId, t, toast, workspaceId],
  );

  const archive = useCallback(() => {
    void (async () => {
      if (workspaceKind === "worktree") {
        const confirmed = await confirmRiskyWorktreeArchive(
          {
            workspaceName: name,
            isDirty,
            aheadOfOrigin,
            diffStat,
          },
          warningLabels,
        );
        if (!confirmed) {
          return;
        }
      }
      await archiveWorkspaceRecord();
    })();
  }, [
    aheadOfOrigin,
    archiveWorkspaceRecord,
    diffStat,
    isDirty,
    name,
    warningLabels,
    workspaceKind,
  ]);

  const deleteWithWorktree = useCallback(() => {
    void (async () => {
      // One dialog, not two: it already says what archive's risky-worktree
      // warning says, plus the part only deletion has — ignored files go too.
      const confirmed = await confirmDialog({
        title: t("sidebar.workspace.confirmations.deleteTitle"),
        message: t("sidebar.workspace.confirmations.deleteMessage", { workspaceName: name }),
        confirmLabel: t("sidebar.workspace.confirmations.deleteConfirm"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await archiveWorkspaceRecord({ removeWorktreeDirectory: true });
    })();
  }, [archiveWorkspaceRecord, name, t]);

  return {
    archive,
    deleteWithWorktree,
  };
}
