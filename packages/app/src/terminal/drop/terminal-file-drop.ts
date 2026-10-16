import type { DesktopHostBridge } from "@/desktop/host";
import { getDroppedFilePath } from "@/desktop/dropped-file-path";

const DANGEROUS_NON_WINDOWS_PATH_CHARS = /[`$|&>~#!^*;<]/g;

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

function escapeNonWindowsPath(path: string): string {
  let nextPath = path;
  if (nextPath.includes("\\")) {
    nextPath = nextPath.replace(/\\/g, "\\\\");
  }

  nextPath = nextPath.replace(DANGEROUS_NON_WINDOWS_PATH_CHARS, "");

  if (nextPath.includes("'") && nextPath.includes('"')) {
    return `$'${nextPath.replace(/'/g, "\\'")}'`;
  }
  if (nextPath.includes("'")) {
    return `'${nextPath.replace(/'/g, "\\'")}'`;
  }
  return `'${nextPath}'`;
}

function escapeWindowsPath(path: string): string {
  if (!path.includes(" ")) {
    return path;
  }
  return `"${path}"`;
}

export function prepareDroppedPathForTerminal(
  path: string,
  bridge: DesktopHostBridge | null,
): string {
  if (bridge?.platform === "win32") {
    return escapeWindowsPath(path);
  }
  return escapeNonWindowsPath(path);
}

export function prepareDroppedPathsForTerminal(
  paths: readonly string[],
  bridge: DesktopHostBridge | null,
): string {
  return paths.map((path) => prepareDroppedPathForTerminal(path, bridge)).join(" ");
}
