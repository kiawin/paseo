import { useCallback, useEffect, useState, type RefCallback } from "react";
import type { View } from "react-native";
import { getDesktopHost } from "@/desktop/host";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { beginNativeWorkspaceFileDrag } from "./native-workspace-file-drag";
import { createWorkspaceFileAttachment } from "./workspace-file";
import { setWorkspaceFileDragData, type WorkspaceFileDragPayload } from "./workspace-file-drag";
import type { WorkspaceFileDragSourceInput } from "./workspace-file-drag-source.types";

// Keep in sync with FILE_DRAG_STAGING_MAX_BYTES in packages/desktop/src/features/file-drag.
const NATIVE_FILE_DRAG_MAX_BYTES = 50 * 1024 * 1024;

type NativeFileSource =
  | { kind: "local"; localPath: string }
  | { kind: "remote"; stage: () => Promise<string | null> };

/**
 * Desktop: drags a workspace file as a real OS file, so a page in the Paseo browser (or any other
 * app) receives the file itself, as from Finder. A file on a remote daemon is fetched into a local
 * temp copy first: the fetch starts on press, and the drag starts once it lands, if the button is
 * still held. Drops back inside Paseo still resolve to the workspace file through
 * native-workspace-file-drag. Without a native source, the in-app drag of the web hook runs.
 */
export function useWorkspaceFileDragSource({
  enabled,
  disabled = false,
  serverId,
  workspaceId,
  path,
  selection,
  size,
}: WorkspaceFileDragSourceInput): RefCallback<View> {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const dragSourceRef = useCallback((node: View | null) => {
    setElement(node as unknown as HTMLElement | null);
  }, []);
  const isLocalDaemon = useIsLocalDaemon(serverId ?? "");
  const workspaceRoot = useWorkspaceDirectory(serverId ?? null, workspaceId ?? null);
  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );

  useEffect(() => {
    if (!element || !enabled || disabled || !serverId || !workspaceId) {
      if (element) {
        element.draggable = false;
      }
      return;
    }

    const payload: WorkspaceFileDragPayload = {
      version: 1,
      serverId,
      workspaceId,
      attachment: createWorkspaceFileAttachment({ path, selection }),
    };
    const fileDrag = getDesktopHost()?.fileDrag;
    const startFileDrag = fileDrag?.start;
    const stageFileCopy = fileDrag?.stage;

    function resolveNativeSource(): NativeFileSource | null {
      if (!startFileDrag || !workspaceRoot) {
        return null;
      }
      if (isLocalDaemon) {
        return {
          kind: "local",
          localPath: buildAbsoluteExplorerPath({ workspaceRoot, entryPath: path }),
        };
      }
      if (!stageFileCopy || !client || (size !== undefined && size > NATIVE_FILE_DRAG_MAX_BYTES)) {
        return null;
      }
      const root = workspaceRoot;
      const daemonClient = client;
      const stage = stageFileCopy;
      return {
        kind: "remote",
        stage: async () => {
          try {
            const file = await daemonClient.readFile(
              root,
              path,
              undefined,
              NATIVE_FILE_DRAG_MAX_BYTES,
              0,
            );
            const fileName = path.split(/[\\/]/).pop() || path;
            return await stage({ fileName, bytes: file.bytes });
          } catch (error) {
            console.warn("[workspace-file-drag] failed to copy remote file for drag:", error);
            return null;
          }
        },
      };
    }

    const nativeSource = resolveNativeSource();
    let pressed = false;
    let pendingCopy: Promise<string | null> | null = null;

    function startNativeDrag(localPath: string, staged: boolean) {
      beginNativeWorkspaceFileDrag({ localPath, staged, payload });
      startFileDrag?.(localPath).catch((error: unknown) => {
        console.warn("[workspace-file-drag] failed to start file drag:", error);
      });
    }

    function handleRelease() {
      pressed = false;
    }

    function handlePointerDown(event: PointerEvent) {
      if (event.button !== 0) {
        return;
      }
      pressed = true;
      window.addEventListener("mouseup", handleRelease, { capture: true, once: true });
      pendingCopy = nativeSource?.kind === "remote" ? nativeSource.stage() : null;
    }

    function handleDragStart(event: DragEvent) {
      if (!nativeSource) {
        if (event.dataTransfer) {
          setWorkspaceFileDragData(event.dataTransfer, payload);
        }
        return;
      }
      // The OS drag replaces the in-app one; drop zones in Paseo recognise it by its path.
      event.preventDefault();
      if (nativeSource.kind === "local") {
        startNativeDrag(nativeSource.localPath, false);
        return;
      }
      const copy = pendingCopy ?? nativeSource.stage();
      pendingCopy = null;
      document.body.style.cursor = "progress";
      void copy.then((localPath) => {
        document.body.style.cursor = "";
        if (localPath && pressed) {
          startNativeDrag(localPath, true);
        }
        return undefined;
      });
    }

    element.draggable = true;
    element.addEventListener("pointerdown", handlePointerDown);
    element.addEventListener("dragstart", handleDragStart);
    return () => {
      element.draggable = false;
      element.removeEventListener("pointerdown", handlePointerDown);
      element.removeEventListener("dragstart", handleDragStart);
      window.removeEventListener("mouseup", handleRelease, { capture: true });
    };
  }, [
    client,
    disabled,
    element,
    enabled,
    isLocalDaemon,
    path,
    selection,
    serverId,
    size,
    workspaceId,
    workspaceRoot,
  ]);

  return dragSourceRef;
}
