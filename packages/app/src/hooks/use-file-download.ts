import { useCallback, useMemo } from "react";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useDownloadStore } from "@/stores/download-store";
import { downloadPlatform } from "@/stores/download-platform";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";

interface UseFileDownloadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

/**
 * Returns a stable callback that downloads a single workspace file by its
 * workspace-relative path. Shared by the file explorer tree and the git diff
 * pane so both surfaces download through the same download-store pipeline instead
 * of duplicating the plumbing: the HTTP token download over a direct TCP connection,
 * the session socket over anything else.
 */
export function useFileDownload({
  serverId,
  workspaceId,
  workspaceRoot,
}: UseFileDownloadParams): (input: { fileName: string; path: string }) => void {
  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceScopeId = useMemo(
    () => workspaceId?.trim() || normalizedWorkspaceRoot,
    [normalizedWorkspaceRoot, workspaceId],
  );
  const { requestFileDownloadToken, requestFileBytes, downloadEntry } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const startDownload = useDownloadStore((state) => state.startDownload);
  const supportsBinaryTransfer = useHostFeature(serverId, "workspaceFileTransfer");

  return useCallback(
    ({ fileName, path }) => {
      if (!workspaceScopeId) {
        return;
      }
      void startDownload({
        serverId,
        scopeId: workspaceScopeId,
        fileName,
        path,
        daemonProfile,
        activeConnectionId: getHostRuntimeStore().getSnapshot(serverId)?.activeConnectionId ?? null,
        requestFileDownloadToken: (targetPath) => requestFileDownloadToken(targetPath),
        downloadEntry: supportsBinaryTransfer ? downloadEntry : undefined,
        platform: downloadPlatform,
        readFile: requestFileBytes,
      });
    },
    [
      daemonProfile,
      requestFileBytes,
      requestFileDownloadToken,
      serverId,
      startDownload,
      downloadEntry,
      supportsBinaryTransfer,
      workspaceScopeId,
    ],
  );
}
