import { rm } from "node:fs/promises";
import { app, ipcMain, nativeImage, type NativeImage } from "electron";
import log from "electron-log/main";

import { resolveFileDragSourcePath, stageFileDragCopy } from "./staging.js";

const DRAG_ICON_SIZE = 64;

async function resolveDragIcon(
  filePath: string,
  getFallbackIconPath: () => Promise<string | null>,
): Promise<NativeImage> {
  const fileIcon = await app.getFileIcon(filePath, { size: "normal" }).catch(() => null);
  if (fileIcon && !fileIcon.isEmpty()) {
    return fileIcon;
  }
  // startDrag throws on macOS when the icon is empty, so fall back to the app icon.
  const fallbackPath = await getFallbackIconPath();
  const fallback = fallbackPath
    ? nativeImage.createFromPath(fallbackPath)
    : nativeImage.createEmpty();
  return fallback.isEmpty()
    ? fallback
    : fallback.resize({ width: DRAG_ICON_SIZE, height: DRAG_ICON_SIZE });
}

/**
 * Lets the renderer start an OS-level file drag, so a page in the Paseo browser (or any other
 * app) receives a real file, the same as a drop from Finder.
 */
export function registerFileDragHandlers(options: {
  stagingRoot: string;
  getFallbackIconPath: () => Promise<string | null>;
}): void {
  // Staged copies only need to outlive one drop; whatever a previous run left is stale.
  void rm(options.stagingRoot, { recursive: true, force: true }).catch((error) => {
    log.warn("[file-drag] failed to clear staging directory", error);
  });

  ipcMain.handle("paseo:file-drag:stage", (_event, input: unknown) => {
    const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return stageFileDragCopy({
      stagingRoot: options.stagingRoot,
      fileName: record.fileName,
      bytes: record.bytes,
    });
  });

  ipcMain.handle("paseo:file-drag:start", async (event, filePath: unknown) => {
    const file = await resolveFileDragSourcePath(filePath);
    const icon = await resolveDragIcon(file, options.getFallbackIconPath);
    event.sender.startDrag({ file, icon });
  });
}
