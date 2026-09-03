import { useCallback } from "react";
import { Text, View } from "react-native";
import { ArrowLeftToLine, RotateCw, Settings, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatConnectionStatus } from "@/utils/daemons";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { WorkspaceRouteState } from "@/screens/workspace/workspace-route-state";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface WorkspaceRouteStateActions {
  onRetryHost: () => void;
  onManageHost: () => void;
  onDismissMissingWorkspace: () => void;
  onRecoverWorkspace: () => void;
  onRetryRecoveryInspection: () => void;
  onRemoveWorktree: (input: { workspaceId: string; worktreePath: string }) => void;
  isRemovingWorktree: boolean;
}

export function renderWorkspaceRouteGate(input: {
  state: WorkspaceRouteState;
  actions: WorkspaceRouteStateActions;
}): React.ReactNode {
  switch (input.state.kind) {
    case "loading":
      return <WorkspaceConnecting hostName={input.state.hostName} />;
    case "missing":
      return (
        <WorkspaceEmptyState
          titleKey="workspace.route.recovery.unavailableTitle"
          hostName={input.state.hostName}
          onDismiss={input.actions.onDismissMissingWorkspace}
        />
      );
    case "archived":
      return (
        <ArchivedWorkspaceRecovery
          state={input.state}
          onRecover={input.actions.onRecoverWorkspace}
          onRemoveWorktree={input.actions.onRemoveWorktree}
          isRemovingWorktree={input.actions.isRemovingWorktree}
        />
      );
    case "needsHostUpgrade":
      return (
        <WorkspaceEmptyState
          titleKey="workspace.route.needsHostUpgrade"
          hostName={input.state.hostName}
          onDismiss={input.actions.onDismissMissingWorkspace}
        />
      );
    case "unreachable":
      return (
        <WorkspaceUnreachable
          state={input.state}
          onRetry={input.actions.onRetryHost}
          onManageHost={input.actions.onManageHost}
        />
      );
    case "recoveryUnavailable":
      return (
        <WorkspaceEmptyState
          titleKey="workspace.route.recovery.unavailableTitle"
          description={input.state.message}
          onDismiss={input.actions.onDismissMissingWorkspace}
        />
      );
    case "recoveryInspectionFailed":
      return (
        <WorkspaceRecoveryInspectionFailed
          state={input.state}
          onRetry={input.actions.onRetryRecoveryInspection}
          onDismiss={input.actions.onDismissMissingWorkspace}
        />
      );
    case "ready":
    case "reconnecting":
      return null;
  }
}

function getWorkspaceHostStateTitle(
  state: Extract<WorkspaceRouteState, { kind: "unreachable" }>,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (state.connectionStatus === "connecting" || state.connectionStatus === "idle") {
    return t("workspace.route.connecting");
  }
  if (state.connectionStatus === "offline") {
    return t("workspace.route.hostOffline", { hostName: state.hostName });
  }
  return t("workspace.route.cannotReachHost", { hostName: state.hostName });
}

function WorkspaceConnecting({ hostName }: { hostName: string }) {
  const { t } = useTranslation();

  return (
    <View style={styles.emptyState}>
      <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      <View style={styles.textStack}>
        <Text style={styles.title}>{t("workspace.route.loading")}</Text>
        <Text style={styles.description}>{hostName}</Text>
      </View>
    </View>
  );
}

/**
 * Removing is a separate, explicit act from archiving. Archive already ran and
 * deliberately left this directory alone, so the only thing that should delete
 * it is someone choosing to.
 */
function RemoveWorktreeAction({
  workspaceId,
  worktreePath,
  onRemove,
  disabled,
  isRemoving,
}: {
  workspaceId: string;
  worktreePath: string;
  onRemove: (input: { workspaceId: string; worktreePath: string }) => void;
  disabled: boolean;
  isRemoving: boolean;
}) {
  const { t } = useTranslation();

  const handlePress = useCallback(() => {
    void (async () => {
      // Git refuses a dirty worktree, but it does not protect ignored files —
      // node_modules and .env go with it — so say that before, not after.
      const confirmed = await confirmDialog({
        title: t("workspace.route.recovery.removeWorktreeTitle"),
        message: t("workspace.route.recovery.removeWorktreeMessage", { path: worktreePath }),
        confirmLabel: t("workspace.route.recovery.removeWorktreeConfirm"),
        destructive: true,
      });
      if (!confirmed) return;
      onRemove({ workspaceId, worktreePath });
    })();
  }, [onRemove, t, workspaceId, worktreePath]);

  return (
    <Button
      size="sm"
      variant="ghost"
      leftIcon={isRemoving ? undefined : Trash2}
      onPress={handlePress}
      disabled={disabled}
      testID="workspace-recovery-remove-worktree"
    >
      {isRemoving
        ? t("workspace.route.recovery.removeWorktreeInProgress")
        : t("workspace.route.recovery.removeWorktreeAction")}
    </Button>
  );
}

function ArchivedWorkspaceRecovery({
  state,
  onRecover,
  onRemoveWorktree,
  isRemovingWorktree,
}: {
  state: Extract<WorkspaceRouteState, { kind: "archived" }>;
  onRecover: () => void;
  onRemoveWorktree: (input: { workspaceId: string; worktreePath: string }) => void;
  isRemovingWorktree: boolean;
}) {
  const { t } = useTranslation();
  const { recovery } = state;
  const isRestoring = recovery.phase === "restoring";
  let actionLabel = t("workspace.route.recovery.unarchiveAction");
  if (recovery.recovery.action === "restore") {
    actionLabel = t("workspace.route.recovery.restoreAction");
  }
  if (recovery.phase === "failed") {
    actionLabel = t("common.actions.retry");
  }
  // Only set when archive left the worktree on disk, which is the one case
  // where there is something for the person to clean up.
  const removableWorktreePath = recovery.recovery.removableWorktreePath ?? null;
  const description =
    recovery.recovery.action === "restore"
      ? t("workspace.route.recovery.restoreDescription", {
          workspaceName: recovery.recovery.workspaceName,
          branch: recovery.recovery.branch,
        })
      : t("workspace.route.recovery.unarchiveDescription", {
          workspaceName: recovery.recovery.workspaceName,
        });

  return (
    <View style={styles.emptyState}>
      {isRestoring ? (
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      ) : null}
      <View style={styles.textStack}>
        <Text style={styles.title}>
          {isRestoring
            ? t("workspace.route.recovery.restoringTitle")
            : t("workspace.route.recovery.archivedTitle")}
        </Text>
        <Text style={styles.description}>{description}</Text>
        {recovery.error ? (
          <Text style={styles.error} testID="workspace-recovery-error">
            {recovery.error}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="default"
          leftIcon={isRestoring ? undefined : RotateCw}
          onPress={onRecover}
          disabled={isRestoring}
          testID="workspace-recovery-action"
        >
          {isRestoring ? t("workspace.route.recovery.restoringAction") : actionLabel}
        </Button>
        {removableWorktreePath ? (
          <RemoveWorktreeAction
            workspaceId={recovery.recovery.workspaceId}
            worktreePath={removableWorktreePath}
            onRemove={onRemoveWorktree}
            disabled={isRestoring || isRemovingWorktree}
            isRemoving={isRemovingWorktree}
          />
        ) : null}
      </View>
      {removableWorktreePath ? (
        <Text style={styles.description} testID="workspace-recovery-worktree-path">
          {removableWorktreePath}
        </Text>
      ) : null}
    </View>
  );
}

function WorkspaceRecoveryInspectionFailed({
  state,
  onRetry,
  onDismiss,
}: {
  state: Extract<WorkspaceRouteState, { kind: "recoveryInspectionFailed" }>;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState}>
      <View style={styles.textStack}>
        <Text style={styles.title}>{t("workspace.route.recovery.checkFailedTitle")}</Text>
        <Text style={styles.error}>{state.error}</Text>
      </View>
      <View style={styles.actions}>
        <Button size="sm" variant="default" leftIcon={RotateCw} onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
        <Button size="sm" variant="outline" leftIcon={ArrowLeftToLine} onPress={onDismiss}>
          {t("common.actions.back")}
        </Button>
      </View>
    </View>
  );
}

function WorkspaceUnreachable({
  state,
  onRetry,
  onManageHost,
}: {
  state: Extract<WorkspaceRouteState, { kind: "unreachable" }>;
  onRetry: () => void;
  onManageHost: () => void;
}) {
  const { t } = useTranslation();
  const canRetry = state.connectionStatus === "offline" || state.connectionStatus === "error";

  return (
    <View style={styles.emptyState}>
      {state.connectionStatus === "connecting" || state.connectionStatus === "idle" ? (
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      ) : null}
      <View style={styles.textStack}>
        <Text style={styles.title}>{getWorkspaceHostStateTitle(state, t)}</Text>
        <Text style={styles.description}>
          {state.connectionStatus === "connecting" || state.connectionStatus === "idle"
            ? state.hostName
            : t("workspace.route.hostStatus", {
                status: formatConnectionStatus(state.connectionStatus),
              })}
        </Text>
        {state.lastError ? (
          <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
            <TooltipTrigger asChild>
              <Text style={styles.error} numberOfLines={3}>
                {state.lastError}
              </Text>
            </TooltipTrigger>
            <TooltipContent side="top" align="center" offset={8}>
              <Text style={styles.errorTooltip}>{state.lastError}</Text>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </View>
      {canRetry ? (
        <View style={styles.actions}>
          <Button size="sm" variant="default" leftIcon={RotateCw} onPress={onRetry}>
            {t("common.actions.retry")}
          </Button>
          <Button size="sm" variant="outline" leftIcon={Settings} onPress={onManageHost}>
            {t("workspace.route.manageHost")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function WorkspaceEmptyState({
  titleKey,
  hostName,
  description,
  onDismiss,
}: {
  titleKey: "workspace.route.needsHostUpgrade" | "workspace.route.recovery.unavailableTitle";
  hostName?: string;
  description?: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();

  return (
    <View style={styles.emptyState}>
      <View style={styles.textStack}>
        <Text style={styles.title}>{t(titleKey)}</Text>
        <Text style={styles.description}>{description ?? hostName}</Text>
      </View>
      <View style={styles.actions}>
        <Button size="sm" variant="default" leftIcon={ArrowLeftToLine} onPress={onDismiss}>
          {t("common.actions.back")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  textStack: {
    alignItems: "center",
    gap: theme.spacing[2],
    maxWidth: 520,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    lineHeight: Math.round(theme.fontSize.base * 1.4),
    textAlign: "center",
  },
  errorTooltip: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.base,
    maxWidth: 420,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
