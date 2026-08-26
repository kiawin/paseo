import { create } from "zustand";
import { File as FSFile, Paths } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { openExternalUrl } from "@/utils/open-external-url";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

interface DownloadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

export interface Download {
  id: string;
  serverId: string;
  scopeId: string;
  fileName: string;
  status: "downloading" | "complete" | "error";
  message?: string;
  progress?: DownloadProgress;
  startedAt: number;
}

interface DownloadState {
  downloads: Map<string, Download>;
  activeDownloadId: string | null;

  startDownload: (params: {
    serverId: string;
    scopeId: string;
    fileName: string;
    path: string;
    daemonProfile: HostProfile | undefined;
    requestFileDownloadToken: (path: string) => Promise<{
      token: string | null;
      fileName: string | null;
      mimeType: string | null;
      error: string | null;
    }>;
    /**
     * Streams the entry over the WebSocket binary channel. Present only when the host
     * advertises `workspaceFileTransfer`; the caller owns that gate. When absent the
     * store falls back to the HTTP endpoint, which cannot work on a relay connection.
     */
    downloadEntry?: (input: {
      path: string;
      sink: {
        onBegin?: (metadata: { size: number; sizeKnown?: boolean }) => void;
        onChunk: (chunk: Uint8Array) => void | Promise<void>;
      };
    }) => Promise<{ fileName: string; mimeType: string; size: number | null }>;
  }) => Promise<void>;

  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string) => void;
  failDownload: (id: string, message: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

/**
 * Drives one download over the WebSocket binary channel.
 *
 * Web collects Blob parts and clicks an object URL; native writes each chunk straight to
 * a file handle so a large download never has to fit in memory. Progress repaints at most
 * once a second — the toast used to repaint on every callback.
 */
async function runBinaryChannelDownload({
  path,
  fileName,
  downloadEntry,
  onProgress,
}: {
  id: string;
  path: string;
  fileName: string;
  downloadEntry: NonNullable<Parameters<DownloadState["startDownload"]>[0]["downloadEntry"]>;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<void> {
  const startedAt = Date.now();
  let receivedBytes = 0;
  let totalBytes = 0;
  let lastRepaintAt = 0;

  const report = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastRepaintAt < 1000) {
      return;
    }
    lastRepaintAt = now;
    const elapsed = (now - startedAt) / 1000;
    const speed = elapsed > 0 ? receivedBytes / elapsed : 0;
    const remaining = totalBytes > 0 ? Math.max(totalBytes - receivedBytes, 0) : 0;
    onProgress({
      percent: totalBytes > 0 ? receivedBytes / totalBytes : 0,
      bytesWritten: receivedBytes,
      totalBytes,
      speed,
      eta: speed > 0 && totalBytes > 0 ? remaining / speed : 0,
    });
  };

  if (isWeb) {
    const parts: Uint8Array[] = [];
    const result = await downloadEntry({
      path,
      sink: {
        onBegin: (metadata) => {
          totalBytes = metadata.sizeKnown === false ? 0 : metadata.size;
        },
        onChunk: (chunk) => {
          parts.push(chunk);
          receivedBytes += chunk.byteLength;
          report(false);
        },
      },
    });
    report(true);

    const resolvedFileName = result.fileName || fileName;
    const blob = new Blob(parts as BlobPart[], {
      type: result.mimeType || "application/octet-stream",
    });
    const objectUrl = URL.createObjectURL(blob);
    try {
      triggerBrowserDownload(objectUrl, resolvedFileName);
    } finally {
      // Revoking synchronously can race the click on some browsers.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
    return;
  }

  const targetFile = resolveDownloadTargetFile(fileName);
  targetFile.create();
  const handle = targetFile.open();
  let result: { fileName: string; mimeType: string; size: number | null };
  try {
    result = await downloadEntry({
      path,
      sink: {
        onBegin: (metadata) => {
          totalBytes = metadata.sizeKnown === false ? 0 : metadata.size;
        },
        onChunk: (chunk) => {
          handle.writeBytes(chunk);
          receivedBytes += chunk.byteLength;
          report(false);
        },
      },
    });
  } finally {
    handle.close();
  }
  report(true);

  if (await Sharing.isAvailableAsync()) {
    const resolvedFileName = result.fileName || fileName;
    await Sharing.shareAsync(targetFile.uri, {
      mimeType: result.mimeType || undefined,
      dialogTitle: resolvedFileName
        ? i18n.t("downloads.shareFileNamed", { fileName: resolvedFileName })
        : i18n.t("downloads.shareFile"),
    });
  }
}

function generateDownloadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useDownloadStore = create<DownloadState>()((set, get) => ({
  downloads: new Map(),
  activeDownloadId: null,

  startDownload: async ({
    serverId,
    scopeId,
    fileName,
    path,
    daemonProfile,
    requestFileDownloadToken,
    downloadEntry,
  }) => {
    const id = generateDownloadId();
    const download: Download = {
      id,
      serverId,
      scopeId,
      fileName,
      status: "downloading",
      startedAt: Date.now(),
    };

    set((state) => ({
      downloads: new Map(state.downloads).set(id, download),
      activeDownloadId: id,
    }));

    try {
      if (downloadEntry) {
        await runBinaryChannelDownload({
          id,
          path,
          fileName,
          downloadEntry,
          onProgress: (progress) => get().updateProgress(id, progress),
        });
        get().completeDownload(id);
        return;
      }

      // COMPAT(httpFileDownload): added in v0.6.2, remove after 2027-02-01 once the daemon
      // floor ships fs.entry.download. This path needs a second origin the relay does not
      // expose, which is the root cause of the #543 issue cluster.
      const tokenResponse = await requestFileDownloadToken(path);
      if (tokenResponse.error || !tokenResponse.token) {
        throw new Error(tokenResponse.error ?? i18n.t("downloads.requestTokenFailed"));
      }

      const downloadTarget = resolveDaemonDownloadTarget(daemonProfile);
      if (!downloadTarget.baseUrl) {
        throw new Error(i18n.t("downloads.hostUnavailable"));
      }

      const resolvedFileName = tokenResponse.fileName ?? fileName;
      const downloadUrl = buildDownloadUrl(
        downloadTarget.baseUrl,
        tokenResponse.token,
        isWeb ? downloadTarget.authCredentials : null,
      );

      if (isWeb) {
        triggerBrowserDownload(downloadUrl, resolvedFileName);
        get().completeDownload(id);
        return;
      }

      const downloadStartTime = Date.now();
      const targetFile = resolveDownloadTargetFile(resolvedFileName);
      const downloadResumable = LegacyFileSystem.createDownloadResumable(
        downloadUrl,
        targetFile.uri,
        downloadTarget.authHeader
          ? { headers: { Authorization: downloadTarget.authHeader } }
          : undefined,
        (data) => {
          const now = Date.now();
          const { totalBytesWritten, totalBytesExpectedToWrite } = data;

          if (totalBytesExpectedToWrite <= 0) {
            return;
          }

          const percent = totalBytesWritten / totalBytesExpectedToWrite;
          const elapsed = (now - downloadStartTime) / 1000;
          const speed = elapsed > 0 ? totalBytesWritten / elapsed : 0;
          const remaining = totalBytesExpectedToWrite - totalBytesWritten;
          const eta = speed > 0 ? remaining / speed : 0;

          get().updateProgress(id, {
            percent,
            bytesWritten: totalBytesWritten,
            totalBytes: totalBytesExpectedToWrite,
            speed,
            eta,
          });
        },
      );

      const result = await downloadResumable.downloadAsync();
      if (!result) {
        throw new Error(i18n.t("downloads.cancelled"));
      }

      get().completeDownload(id);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(result.uri, {
          mimeType: tokenResponse.mimeType ?? undefined,
          dialogTitle: resolvedFileName
            ? i18n.t("downloads.shareFileNamed", { fileName: resolvedFileName })
            : i18n.t("downloads.shareFile"),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
      if (isWeb) {
        console.warn("[DownloadStore] Download failed:", message);
        get().failDownload(id, message);
        return;
      }
      get().failDownload(id, message);
    }
  },

  updateProgress: (id, progress) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download || download.status !== "downloading") {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, progress });
      return { downloads: updated };
    });
  },

  completeDownload: (id) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, status: "complete" });
      return { downloads: updated };
    });
  },

  failDownload: (id, message) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, status: "error", message });
      return { downloads: updated };
    });
  },

  dismissDownload: (id) => {
    set((state) => {
      const updated = new Map(state.downloads);
      updated.delete(id);
      const newActiveId =
        state.activeDownloadId === id ? findMostRecentDownloadId(updated) : state.activeDownloadId;
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },

  dismissAllCompleted: () => {
    set((state) => {
      const updated = new Map(state.downloads);
      for (const [id, download] of updated) {
        if (download.status !== "downloading") {
          updated.delete(id);
        }
      }
      let newActiveId: string | null;
      if (!state.activeDownloadId) newActiveId = null;
      else if (updated.has(state.activeDownloadId)) newActiveId = state.activeDownloadId;
      else newActiveId = findMostRecentDownloadId(updated);
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },
}));

function findMostRecentDownloadId(downloads: Map<string, Download>): string | null {
  let mostRecent: Download | null = null;
  for (const download of downloads.values()) {
    if (!mostRecent || download.startedAt > mostRecent.startedAt) {
      mostRecent = download;
    }
  }
  return mostRecent?.id ?? null;
}

interface DownloadTarget {
  baseUrl: string | null;
  authHeader: string | null;
  authCredentials: { username: string; password: string } | null;
}

function resolveDaemonDownloadTarget(daemon?: HostProfile): DownloadTarget {
  const connection = daemon?.connections.find((conn) => conn.type === "directTcp") ?? null;
  if (!connection) {
    return { baseUrl: null, authHeader: null, authCredentials: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(
      buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    );
  } catch {
    return { baseUrl: null, authHeader: null, authCredentials: null };
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }

  let authCredentials: { username: string; password: string } | null = null;
  if (parsed.username || parsed.password) {
    authCredentials = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
    parsed.username = "";
    parsed.password = "";
  }

  parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "/");

  const baseUrl = parsed.origin;
  const authHeader = authCredentials
    ? `Basic ${btoa(`${authCredentials.username}:${authCredentials.password}`)}`
    : null;

  return { baseUrl, authHeader, authCredentials };
}

function buildDownloadUrl(
  baseUrl: string,
  token: string,
  authCredentials: { username: string; password: string } | null,
): string {
  const url = new URL("/api/files/download", baseUrl);
  url.searchParams.set("token", token);
  if (authCredentials) {
    url.username = authCredentials.username;
    url.password = authCredentials.password;
  }
  return url.toString();
}

function triggerBrowserDownload(url: string, fileName: string) {
  if (typeof document === "undefined") {
    if (typeof window !== "undefined") {
      void openExternalUrl(url);
    }
    return;
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function resolveDownloadTargetFile(fileName: string): FSFile {
  const directory = Paths.cache ?? Paths.document;
  if (!directory) {
    throw new Error("No download directory available.");
  }

  const safeName = sanitizeDownloadFileName(fileName);
  const split = splitFileName(safeName);
  let targetFile = new FSFile(directory, safeName);
  let suffix = 1;

  while (targetFile.exists) {
    targetFile = new FSFile(directory, `${split.base} (${suffix})${split.ext}`);
    suffix += 1;
  }

  return targetFile;
}

function sanitizeDownloadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "download";
  }
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
}

function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { base: fileName, ext: "" };
  }
  return {
    base: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot),
  };
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 1) {
    return "< 1s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
