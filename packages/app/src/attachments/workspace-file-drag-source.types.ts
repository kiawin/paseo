import type { WorkspaceFileSelection } from "./types";

export interface WorkspaceFileDragSourceInput {
  enabled: boolean;
  disabled?: boolean;
  serverId?: string;
  workspaceId: string | null | undefined;
  path: string;
  selection?: WorkspaceFileSelection;
  /** File size in bytes when known; desktop skips the native drag for remote files over its limit. */
  size?: number;
}
