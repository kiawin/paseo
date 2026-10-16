import { getMimeTypeFromPath } from "@/attachments/file-types";
import { readDesktopFileBytes } from "@/attachments/selected-file";
import type { DroppedItem } from "@/components/file-drop/types";
import type { DesktopHostBridge } from "@/desktop/host";
import { getDroppedFilePath } from "@/desktop/dropped-file-path";
import { readTerminalFile, type TerminalFile } from "../file-paste";

export function isTerminalFileDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}

interface ContainsTarget {
  contains: (other: EventTarget | null) => boolean;
}

function asContainsTarget(value: EventTarget | null): ContainsTarget | null {
  if (!value || typeof (value as Partial<ContainsTarget>).contains !== "function") {
    return null;
  }
  return value as unknown as ContainsTarget;
}

export function isTerminalDragLeaveOutside(input: {
  currentTarget: EventTarget | null;
  relatedTarget: EventTarget | null;
}): boolean {
  const currentTarget = asContainsTarget(input.currentTarget);
  if (!currentTarget || !input.relatedTarget) {
    return true;
  }
  return !currentTarget.contains(input.relatedTarget);
}

export function extractTerminalDropPaths(
  dataTransfer: DataTransfer | null,
  bridge: DesktopHostBridge | null,
): string[] {
  if (!dataTransfer) {
    return [];
  }

  const paths: string[] = [];
  for (const file of Array.from(dataTransfer.files)) {
    const path = getDroppedFilePath(file, bridge);
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}

function getLegacyFilePath(file: File): string | null {
  const path = Reflect.get(file, "path");
  return typeof path === "string" && path.length > 0 ? path : null;
}

/** Where the client's own filesystem holds a dropped file; null for files that are only bytes. */
function getClientFilePath(file: File, bridge: DesktopHostBridge | null): string | null {
  const getPathForFile = bridge?.webUtils?.getPathForFile;
  if (typeof getPathForFile === "function") {
    try {
      const path = getPathForFile(file);
      if (typeof path === "string" && path.length > 0) {
        return path;
      }
    } catch {
      // Fall through to the legacy Electron File.path property if present.
    }
  }
  return getLegacyFilePath(file);
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? path;
}

async function readDesktopFile(path: string): Promise<TerminalFile> {
  return {
    fileName: fileNameFromPath(path),
    mimeType: getMimeTypeFromPath(path),
    bytes: await readDesktopFileBytes(path),
  };
}

/** How a dropped item reaches the terminal. */
export type TerminalDropDelivery =
  | { kind: "path"; path: string }
  | { kind: "upload"; read: () => Promise<TerminalFile> };

/**
 * A dropped file pastes its own path only when the host is the machine the file
 * sits on. Anywhere else the host cannot read the client's disk, so the bytes are
 * uploaded and the host path is pasted instead. The file's type plays no part.
 */
export function routeTerminalDrop(
  item: DroppedItem,
  input: { hostIsLocal: boolean; bridge: DesktopHostBridge | null },
): TerminalDropDelivery {
  if (item.kind === "desktop-path") {
    return input.hostIsLocal
      ? { kind: "path", path: item.path }
      : { kind: "upload", read: () => readDesktopFile(item.path) };
  }
  const clientPath = input.hostIsLocal ? getClientFilePath(item.file, input.bridge) : null;
  return clientPath
    ? { kind: "path", path: clientPath }
    : { kind: "upload", read: () => readTerminalFile(item.file) };
}
