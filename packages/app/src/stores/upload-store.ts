import { create } from "zustand";
import { i18n } from "@/i18n/i18next";

interface UploadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

export interface Upload {
  id: string;
  serverId: string;
  scopeId: string;
  fileName: string;
  status: "uploading" | "complete" | "error";
  message?: string;
  progress?: UploadProgress;
  startedAt: number;
}

export interface UploadEntryFile {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

interface UploadState {
  uploads: Map<string, Upload>;
  activeUploadId: string | null;

  /**
   * Uploads picked files into `parentPath`, one at a time.
   *
   * Sequential rather than parallel: the daemon paces each transfer with its own ack
   * window, and running several at once would only compete for the same socket.
   */
  startUploads: (params: {
    serverId: string;
    scopeId: string;
    parentPath: string;
    files: UploadEntryFile[];
    uploadEntry: (input: {
      path: string;
      bytes: Uint8Array;
      mimeType: string;
      overwrite: "fail" | "replace" | "rename";
    }) => Promise<{ path: string; size: number }>;
    onUploaded?: (parentPath: string) => void;
  }) => Promise<void>;

  updateProgress: (id: string, progress: UploadProgress) => void;
  completeUpload: (id: string) => void;
  failUpload: (id: string, message: string) => void;
  dismissUpload: (id: string) => void;
}

function generateUploadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function joinExplorerPath(parentPath: string, fileName: string): string {
  const normalizedParent = parentPath === "." || parentPath === "" ? "" : `${parentPath}/`;
  return `${normalizedParent}${fileName}`;
}

export const useUploadStore = create<UploadState>()((set, get) => ({
  uploads: new Map(),
  activeUploadId: null,

  startUploads: async ({ serverId, scopeId, parentPath, files, uploadEntry, onUploaded }) => {
    let uploadedAny = false;

    for (const file of files) {
      const id = generateUploadId();
      set((state) => ({
        uploads: new Map(state.uploads).set(id, {
          id,
          serverId,
          scopeId,
          fileName: file.fileName,
          status: "uploading",
          startedAt: Date.now(),
        }),
        activeUploadId: id,
      }));

      const startedAt = Date.now();
      try {
        get().updateProgress(id, {
          percent: 0,
          bytesWritten: 0,
          totalBytes: file.bytes.byteLength,
          speed: 0,
          eta: 0,
        });

        await uploadEntry({
          path: joinExplorerPath(parentPath, file.fileName),
          bytes: file.bytes,
          mimeType: file.mimeType,
          // Never clobber silently: an existing name gets a suffix instead.
          overwrite: "rename",
        });

        const elapsed = (Date.now() - startedAt) / 1000;
        get().updateProgress(id, {
          percent: 1,
          bytesWritten: file.bytes.byteLength,
          totalBytes: file.bytes.byteLength,
          speed: elapsed > 0 ? file.bytes.byteLength / elapsed : 0,
          eta: 0,
        });
        get().completeUpload(id);
        uploadedAny = true;
      } catch (error) {
        get().failUpload(id, error instanceof Error ? error.message : i18n.t("uploads.failed"));
      }
    }

    if (uploadedAny) {
      onUploaded?.(parentPath);
    }
  },

  updateProgress: (id, progress) => {
    set((state) => {
      const upload = state.uploads.get(id);
      if (!upload || upload.status !== "uploading") {
        return state;
      }
      const updated = new Map(state.uploads);
      updated.set(id, { ...upload, progress });
      return { uploads: updated };
    });
  },

  completeUpload: (id) => {
    set((state) => {
      const upload = state.uploads.get(id);
      if (!upload) {
        return state;
      }
      const updated = new Map(state.uploads);
      updated.set(id, { ...upload, status: "complete" });
      return { uploads: updated };
    });
  },

  failUpload: (id, message) => {
    set((state) => {
      const upload = state.uploads.get(id);
      if (!upload) {
        return state;
      }
      const updated = new Map(state.uploads);
      updated.set(id, { ...upload, status: "error", message });
      return { uploads: updated };
    });
  },

  dismissUpload: (id) => {
    set((state) => {
      const updated = new Map(state.uploads);
      updated.delete(id);
      return {
        uploads: updated,
        activeUploadId: state.activeUploadId === id ? null : state.activeUploadId,
      };
    });
  },
}));
