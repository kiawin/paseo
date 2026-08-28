import { useCallback, useRef } from "react";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { isWeb } from "@/constants/platform";
import { getMimeTypeFromPath } from "@/attachments/file-types";
import { readDesktopFileBytes, type SelectedFile } from "@/attachments/selected-file";
import type { PickedFile } from "@/attachments/picked-file";

async function pickFilesWithDesktopDialog(): Promise<SelectedFile[] | null> {
  const dialog = getDesktopHost()?.dialog;
  const dialogOpen = dialog?.open;
  if (typeof dialogOpen !== "function") {
    throw new Error("Desktop dialog API is not available.");
  }

  const selection = await dialogOpen({
    directory: false,
    multiple: true,
  });

  if (!selection) {
    return null;
  }

  const paths = Array.isArray(selection) ? selection : [selection];
  if (paths.length === 0) {
    return null;
  }

  const result: SelectedFile[] = [];

  for (const filePath of paths) {
    const fileName = filePath.split("/").pop() ?? filePath.split("\\").pop() ?? filePath;
    const mimeType = getMimeTypeFromPath(filePath);
    result.push({ fileName, mimeType, readBytes: () => readDesktopFileBytes(filePath) });
  }

  return result;
}

function pickFilesWithWebInput(): Promise<SelectedFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";

    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        resolve(null);
        return;
      }

      const result: SelectedFile[] = [];
      for (const file of files) {
        result.push({
          fileName: file.name,
          mimeType: file.type || getMimeTypeFromPath(file.name),
          readBytes: async () => new Uint8Array(await file.arrayBuffer()),
        });
      }
      resolve(result);
    });

    input.addEventListener("cancel", () => {
      resolve(null);
    });

    document.body.appendChild(input);
    input.click();

    // Clean up after a short delay to allow the change event to fire
    setTimeout(() => {
      input.remove();
    }, 60_000);
  });
}

async function pickFilesWithDocumentPicker(): Promise<SelectedFile[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  return result.assets.map((asset) => ({
    fileName: asset.name,
    mimeType: asset.mimeType ?? getMimeTypeFromPath(asset.name),
    readBytes: () => new File(asset.uri).bytes(),
  }));
}

/**
 * Picks a folder and returns every file under it, each tagged with its path inside
 * the tree so the upload can recreate the structure.
 *
 * Electron is Chromium, so this input works there too — no desktop dialog and no
 * privileged directory-walk IPC is needed. iOS and Android have no equivalent:
 * their pickers hand back files, never trees.
 */
function pickDirectoryWithWebInput(): Promise<PickedFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    // Not in the HTML type definitions, but supported by every Chromium and WebKit build
    // that can reach this code path.
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.style.display = "none";

    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        resolve(null);
        return;
      }

      const result: PickedFile[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // `File` in this module is expo-file-system's class, not the DOM one, so this
        // goes through unknown rather than intersecting the wrong type.
        const { webkitRelativePath } = file as unknown as { webkitRelativePath?: string };
        result.push({
          fileName: file.name,
          mimeType: file.type || getMimeTypeFromPath(file.name),
          bytes,
          relativePath: webkitRelativePath || file.name,
        });
      }
      resolve(result);
    });

    input.addEventListener("cancel", () => {
      resolve(null);
    });

    document.body.appendChild(input);
    input.click();

    setTimeout(() => {
      input.remove();
    }, 60_000);
  });
}

export function useFilePicker() {
  const isPickingRef = useRef(false);

  const pickFiles = useCallback(async (): Promise<SelectedFile[] | null> => {
    if (isPickingRef.current) {
      return null;
    }
    isPickingRef.current = true;

    try {
      if (isWeb && isElectronRuntime()) {
        return await pickFilesWithDesktopDialog();
      }

      if (isWeb) {
        return await pickFilesWithWebInput();
      }

      return await pickFilesWithDocumentPicker();
    } catch (error) {
      console.error("[FilePicker] Failed to pick files:", error);
      throw error;
    } finally {
      isPickingRef.current = false;
    }
  }, []);

  const pickDirectory = useCallback(async (): Promise<PickedFile[] | null> => {
    if (!isWeb) {
      throw new Error("Folder upload is not available on this platform.");
    }
    if (isPickingRef.current) {
      return null;
    }
    isPickingRef.current = true;

    try {
      return await pickDirectoryWithWebInput();
    } catch (error) {
      console.error("[FilePicker] Failed to pick a folder:", error);
      throw error;
    } finally {
      isPickingRef.current = false;
    }
  }, []);

  return { pickFiles, pickDirectory };
}
