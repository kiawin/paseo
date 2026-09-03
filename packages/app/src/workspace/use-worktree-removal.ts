import { useCallback, useState } from "react";
import type { TFunction } from "i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { describeWorktreeRemoval } from "./describe-worktree-removal";

interface ToastLike {
  show: (message: string, options?: { variant?: "success" | "error" }) => void;
}

/**
 * Removes an archived workspace's worktree directory.
 *
 * Separate from archive on purpose: archive already ran and deliberately left
 * this directory alone, so removing it is its own explicit act.
 */
export function useWorktreeRemoval(input: {
  client: Pick<DaemonClient, "removeWorkspaceWorktree"> | null;
  t: TFunction;
  toast: ToastLike;
  /** Re-inspects recovery state, so a removed directory stops being offered. */
  onRemoved?: () => void;
}): {
  isRemovingWorktree: boolean;
  removeWorktree: (target: { workspaceId: string; worktreePath: string }) => void;
} {
  const { client, t, toast, onRemoved } = input;
  const [isRemovingWorktree, setIsRemovingWorktree] = useState(false);

  const removeWorktree = useCallback(
    (target: { workspaceId: string; worktreePath: string }) => {
      if (!client) return;
      setIsRemovingWorktree(true);
      void (async () => {
        try {
          const result = await client.removeWorkspaceWorktree(target.workspaceId);
          const outcome = describeWorktreeRemoval({
            result,
            fallbackPath: target.worktreePath,
            t,
          });
          toast.show(outcome.message, { variant: outcome.variant });
          // The directory is gone, so the screen must stop offering to remove it
          // and stop printing the path as though it were still there.
          if (outcome.variant === "success") onRemoved?.();
        } catch (error) {
          toast.show(
            error instanceof Error
              ? error.message
              : t("workspace.route.recovery.removeWorktreeRefused"),
            { variant: "error" },
          );
        } finally {
          setIsRemovingWorktree(false);
        }
      })();
    },
    [client, onRemoved, t, toast],
  );

  return { isRemovingWorktree, removeWorktree };
}
