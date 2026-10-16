import type { WorkspaceFileDragPayload } from "./workspace-file-drag";

/**
 * A workspace file dragged as a real OS file (Electron) carries only the file, not the in-app
 * drag payload. Remember the payload here so drop zones inside Paseo can recognise their own
 * drag when it comes back as a file drop.
 */
export interface NativeWorkspaceFileDrag {
  /** Local path handed to the OS drag: the file itself, or a staged copy of a remote file. */
  localPath: string;
  /** True when localPath is a temp copy of a file that lives on a remote daemon. */
  staged: boolean;
  payload: WorkspaceFileDragPayload;
}

let activeDrag: NativeWorkspaceFileDrag | null = null;
let clearOnPressInstalled = false;

function clearActiveDrag(): void {
  activeDrag = null;
}

export function beginNativeWorkspaceFileDrag(drag: NativeWorkspaceFileDrag): void {
  activeDrag = drag;
  if (!clearOnPressInstalled && typeof window !== "undefined") {
    clearOnPressInstalled = true;
    // A drop that lands outside this document (the browser pane, another app) fires nothing
    // here, so the next press ends the drag instead.
    window.addEventListener("pointerdown", clearActiveDrag, true);
  }
}

/**
 * Ends the active drag and returns it when the drop is that drag coming back: exactly one file
 * at the path the drag started with. A matching drop from the file manager is the same file,
 * so it resolves the same way.
 */
export function takeNativeWorkspaceFileDrop(
  droppedPaths: readonly string[],
): NativeWorkspaceFileDrag | null {
  const drag = activeDrag;
  activeDrag = null;
  if (!drag || droppedPaths.length !== 1 || droppedPaths[0] !== drag.localPath) {
    return null;
  }
  return drag;
}
