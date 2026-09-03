import type { TFunction } from "i18next";
import type { WorkspaceWorktreeRemoveResponse } from "@getpaseo/protocol/messages";

export interface WorktreeRemovalOutcome {
  message: string;
  variant: "success" | "error";
}

/**
 * Turns a removal response into what the person should be told.
 *
 * `not_a_worktree` is terminal: git has disowned the directory and no force
 * level recovers it, so the only useful thing to hand over is the path. Every
 * other refusal is git declining for a reason it already stated.
 */
export function describeWorktreeRemoval(input: {
  result: WorkspaceWorktreeRemoveResponse["payload"];
  fallbackPath: string;
  t: TFunction;
}): WorktreeRemovalOutcome {
  const { result, t } = input;

  if (result.removed) {
    return { message: t("workspace.route.recovery.removeWorktreeDone"), variant: "success" };
  }

  if (result.refusal === "not_a_worktree") {
    const path = result.worktreePath ?? input.fallbackPath;
    return {
      message: `${t("workspace.route.recovery.removeWorktreeTerminal")} ${path}`,
      variant: "error",
    };
  }

  return {
    message: result.error ?? t("workspace.route.recovery.removeWorktreeRefused"),
    variant: "error",
  };
}
