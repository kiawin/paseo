import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import {
  FOCUSED_PANE_PLACEMENT,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

interface OpenWorkspaceTargetFromExplorerInput {
  persistenceKey: string | null;
  closeExplorerAfterOpen: boolean;
  showMobileAgent: () => void;
  openWorkspaceTabInFocusedPane: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    placement?: WorkspaceTabPlacement,
  ) => string | null;
  focusWorkspaceTab: (workspaceKey: string, tabId: string) => void;
}

interface OpenWorkspaceFileFromExplorerInput extends OpenWorkspaceTargetFromExplorerInput {
  filePath: string;
}

/** Opens any Explorer selection as a tab in the focused pane, closing the overlay behind it. */
export function openWorkspaceTargetFromExplorer(
  input: OpenWorkspaceTargetFromExplorerInput & { target: WorkspaceTabTarget },
): void {
  if (input.closeExplorerAfterOpen) {
    input.showMobileAgent();
  }
  if (!input.persistenceKey) {
    return;
  }
  const tabId = input.openWorkspaceTabInFocusedPane(
    input.persistenceKey,
    input.target,
    FOCUSED_PANE_PLACEMENT,
  );
  if (tabId) {
    input.focusWorkspaceTab(input.persistenceKey, tabId);
  }
}

export function openWorkspaceFileFromExplorer(input: OpenWorkspaceFileFromExplorerInput): void {
  const location = normalizeWorkspaceFileLocation({ path: input.filePath });
  if (!location) {
    // Still honour the overlay dismissal so a bad path does not leave it stuck open.
    if (input.closeExplorerAfterOpen) input.showMobileAgent();
    return;
  }
  openWorkspaceTargetFromExplorer({ ...input, target: createWorkspaceFileTabTarget(location) });
}
