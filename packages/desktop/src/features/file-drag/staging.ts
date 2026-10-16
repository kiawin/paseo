import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Keep in sync with NATIVE_FILE_DRAG_MAX_BYTES in the app's native workspace file drag source.
export const FILE_DRAG_STAGING_MAX_BYTES = 50 * 1024 * 1024;
// A drop target may read the dragged file after the drop finishes, so a staged copy has to
// outlive the drag. An hour is far past any drop, and pruning keeps the directory bounded.
export const FILE_DRAG_STAGED_COPY_TTL_MS = 60 * 60 * 1000;

export function normalizeStagedFileName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("File name is required.");
  }
  const name = path.basename(value.replace(/\\/g, "/")).trim();
  if (name.length === 0 || name === "." || name === "..") {
    throw new Error(`Invalid file name: ${value}`);
  }
  return name;
}

export async function pruneStagedFileDragCopies(input: {
  stagingRoot: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  let entries: string[];
  try {
    entries = await readdir(input.stagingRoot);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(input.stagingRoot, entry);
      const info = await stat(entryPath).catch(() => null);
      if (info && now - info.mtimeMs > FILE_DRAG_STAGED_COPY_TTL_MS) {
        await rm(entryPath, { recursive: true, force: true });
      }
    }),
  );
}

/**
 * Writes bytes fetched from a remote daemon to a local file so the OS can drag it. Each copy
 * gets its own directory, which keeps the original file name for the drop target.
 */
export async function stageFileDragCopy(input: {
  stagingRoot: string;
  fileName: unknown;
  bytes: unknown;
}): Promise<string> {
  const fileName = normalizeStagedFileName(input.fileName);
  if (!(input.bytes instanceof Uint8Array)) {
    throw new Error("File bytes are required.");
  }
  if (input.bytes.byteLength > FILE_DRAG_STAGING_MAX_BYTES) {
    throw new Error(`File is larger than ${FILE_DRAG_STAGING_MAX_BYTES} bytes.`);
  }
  await pruneStagedFileDragCopies({ stagingRoot: input.stagingRoot });
  const copyDir = path.join(input.stagingRoot, randomUUID());
  await mkdir(copyDir, { recursive: true });
  const filePath = path.join(copyDir, fileName);
  await writeFile(filePath, input.bytes);
  return filePath;
}

export async function resolveFileDragSourcePath(value: unknown): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("An absolute file path is required.");
  }
  const info = await stat(value);
  if (!info.isFile()) {
    throw new Error(`Not a file: ${value}`);
  }
  return value;
}
