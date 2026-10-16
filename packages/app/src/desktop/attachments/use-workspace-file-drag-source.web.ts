import { useCallback, useEffect, useState, type RefCallback } from "react";
import type { View } from "react-native";
import { createWorkspaceFileAttachment } from "@/attachments/workspace-file";
import { setWorkspaceFileDragData } from "@/attachments/workspace-file-drag";
import type { WorkspaceFileDragSourceInput } from "@/attachments/workspace-file-drag-source.types";

export function useWorkspaceFileDragSource({
  enabled,
  disabled = false,
  serverId,
  workspaceId,
  path,
  selection,
}: WorkspaceFileDragSourceInput): RefCallback<View> {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const dragSourceRef = useCallback((node: View | null) => {
    setElement(node as unknown as HTMLElement | null);
  }, []);

  useEffect(() => {
    if (!element || !enabled || disabled || !serverId || !workspaceId) {
      if (element) {
        element.draggable = false;
      }
      return;
    }

    const sourceServerId = serverId;
    const sourceWorkspaceId = workspaceId;
    element.draggable = true;
    function handleDragStart(event: DragEvent) {
      if (!event.dataTransfer) {
        return;
      }
      setWorkspaceFileDragData(event.dataTransfer, {
        version: 1,
        serverId: sourceServerId,
        workspaceId: sourceWorkspaceId,
        attachment: createWorkspaceFileAttachment({ path, selection }),
      });
    }
    element.addEventListener("dragstart", handleDragStart);
    return () => {
      element.draggable = false;
      element.removeEventListener("dragstart", handleDragStart);
    };
  }, [disabled, element, enabled, path, selection, serverId, workspaceId]);

  return dragSourceRef;
}
