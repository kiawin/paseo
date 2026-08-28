import { create } from "zustand";
import type { DownloadPlatform } from "./download-platform-types";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { i18n } from "@/i18n/i18next";

interface DownloadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

// The session path holds the file in memory two to three times over (client chunks, the
// concatenated result, then the Blob or native write). Lift once the client streams chunks to disk.
export const MAX_SESSION_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export interface DownloadedBytes {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string | null;
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
    /** Connection the host runtime is using right now; `null` while disconnected. */
    activeConnectionId?: string | null;
    requestFileDownloadToken: (path: string) => Promise<{
      token: string | null;
      fileName: string | null;
      mimeType: string | null;
      size?: number | null;
      error: string | null;
    }>;
    /** Reads the whole file over the session socket; used when no direct HTTP endpoint is active. */
    readFile?: (path: string, maxBytes: number) => Promise<{ bytes: Uint8Array; size: number }>;
    saveFile?: (file: DownloadedBytes) => Promise<string | null>;
    /**
     * Streams the entry over the WebSocket binary channel. Present only when the host
     * advertises `workspaceFileTransfer`; the caller owns that gate. When absent the
     * store falls back to the HTTP endpoint, which cannot work on a relay connection.
     */
    downloadEntry?: (input: {
      path: string;
      sink: {
        onBegin?: (metadata: { size: number; sizeKnown?: boolean; fileName?: string }) => void;
        onChunk: (chunk: Uint8Array) => void | Promise<void>;
      };
      signal?: AbortSignal;
    }) => Promise<{ fileName: string; mimeType: string; size: number | null }>;
    /** Filesystem and sharing, injected so this store carries no Expo imports. */
    platform: DownloadPlatform;
  }) => Promise<void>;

  /** Aborts an in-flight download, which sends fs.transfer.cancel and stops the daemon. */
  cancelDownload: (id: string) => void;
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
  platform,
  signal,
  onProgress,
}: {
  id: string;
  path: string;
  fileName: string;
  downloadEntry: NonNullable<Parameters<DownloadState["startDownload"]>[0]["downloadEntry"]>;
  platform: DownloadPlatform;
  signal?: AbortSignal;
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

  if (platform.isWeb) {
    const parts: Uint8Array[] = [];
    const result = await downloadEntry({
      path,
      signal,
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
      platform.deliverToBrowser(objectUrl, resolvedFileName);
    } finally {
      // Revoking synchronously can race the click on some browsers.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
    return;
  }

  // The cache file is named from FileBegin, not from the caller: a folder download is
  // requested as "site" but arrives as "site.zip", and the share sheet hands over this
  // URI as-is, so a file created under the wrong name reaches the OS without its
  // extension. Creation therefore waits until the daemon has said what this is.
  let cacheFile: ReturnType<DownloadPlatform["createCacheFile"]> | null = null;
  let result: { fileName: string; mimeType: string; size: number | null };
  try {
    result = await downloadEntry({
      path,
      signal,
      sink: {
        onBegin: (metadata) => {
          totalBytes = metadata.sizeKnown === false ? 0 : metadata.size;
          cacheFile = platform.createCacheFile(metadata.fileName || fileName);
        },
        onChunk: (chunk) => {
          if (!cacheFile) {
            return;
          }
          cacheFile.write(chunk);
          receivedBytes += chunk.byteLength;
          report(false);
        },
      },
    });
  } catch (error) {
    // Nothing usable was produced, so do not leave a partial file in the cache to be
    // suffixed around by the next attempt.
    const partial = cacheFile as ReturnType<DownloadPlatform["createCacheFile"]> | null;
    partial?.close();
    cacheFile = null;
    try {
      partial?.remove();
    } catch {
      // Best effort: a cache file we cannot remove must not mask the transfer error.
    }
    throw error;
  } finally {
    (cacheFile as ReturnType<DownloadPlatform["createCacheFile"]> | null)?.close();
  }
  report(true);

  const savedFile = cacheFile as ReturnType<DownloadPlatform["createCacheFile"]> | null;
  if (savedFile && (await platform.isSharingAvailable())) {
    const resolvedFileName = result.fileName || fileName;
    await platform.share(savedFile.uri, {
      mimeType: result.mimeType || undefined,
      dialogTitle: resolvedFileName
        ? i18n.t("downloads.shareFileNamed", { fileName: resolvedFileName })
        : i18n.t("downloads.shareFile"),
    });
  }
}

async function runSessionSocketDownload({
  path,
  fileName,
  mimeType,
  size,
  readFile,
  saveFile,
  platform,
  onComplete,
}: {
  path: string;
  fileName: string;
  mimeType: string | null;
  size: number | null | undefined;
  readFile: Parameters<DownloadState["startDownload"]>[0]["readFile"];
  saveFile: Parameters<DownloadState["startDownload"]>[0]["saveFile"];
  platform: DownloadPlatform;
  onComplete: () => void;
}): Promise<void> {
  // Relay, SSH, socket and pipe hosts have no HTTP endpoint: read the file over the
  // session socket that is already connected (#543).
  if (typeof size === "number" && size > MAX_SESSION_DOWNLOAD_BYTES) {
    throw new Error(i18n.t("composer.errors.fileTooLarge", { fileName, size: "64 MB" }));
  }
  if (!readFile) {
    throw new Error("File reader unavailable.");
  }
  const { bytes, size: receivedSize } = await readFile(path, MAX_SESSION_DOWNLOAD_BYTES);
  // A daemon without a binary channel answers `encoding: "none"` for a binary file: no
  // content, real size. Never save that as a complete download.
  if (bytes.byteLength !== receivedSize) {
    throw new Error(
      `File transfer incomplete: expected ${receivedSize} bytes, received ${bytes.byteLength}.`,
    );
  }
  const savedUri = await (saveFile ?? ((file) => saveDownloadedBytes(platform, file)))({
    bytes,
    fileName,
    mimeType,
  });
  onComplete();
  if (savedUri !== null && (await platform.isSharingAvailable())) {
    await platform.share(savedUri, {
      mimeType: mimeType ?? undefined,
      dialogTitle: fileName
        ? i18n.t("downloads.shareFileNamed", { fileName })
        : i18n.t("downloads.shareFile"),
    });
  }
}

/**
 * Abort handles for in-flight downloads, keyed by download id. Kept outside the store
 * state: they are not rendered, and putting non-serialisable handles in state invites
 * them being treated as data.
 */
const downloadAbortControllers = new Map<string, AbortController>();

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
    activeConnectionId = null,
    requestFileDownloadToken,
    readFile,
    saveFile,
    downloadEntry,
    platform,
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
        const controller = new AbortController();
        downloadAbortControllers.set(id, controller);
        try {
          await runBinaryChannelDownload({
            id,
            path,
            fileName,
            downloadEntry,
            platform,
            signal: controller.signal,
            onProgress: (progress) => get().updateProgress(id, progress),
          });
        } finally {
          downloadAbortControllers.delete(id);
        }
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

      const resolvedFileName = tokenResponse.fileName ?? fileName;
      const downloadTarget = resolveDaemonDownloadTarget(daemonProfile, activeConnectionId);
      if (!downloadTarget) {
        await runSessionSocketDownload({
          path,
          fileName: resolvedFileName,
          mimeType: tokenResponse.mimeType,
          size: tokenResponse.size,
          readFile,
          saveFile,
          platform,
          onComplete: () => get().completeDownload(id),
        });
        return;
      }
      if (!downloadTarget.baseUrl) {
        throw new Error(i18n.t("downloads.hostUnavailable"));
      }

      const downloadUrl = buildDownloadUrl(
        downloadTarget.baseUrl,
        tokenResponse.token,
        platform.isWeb ? downloadTarget.authCredentials : null,
      );

      if (platform.isWeb) {
        platform.deliverToBrowser(downloadUrl, resolvedFileName);
        get().completeDownload(id);
        return;
      }

      const downloadStartTime = Date.now();
      const result = await platform.downloadOverHttp({
        url: downloadUrl,
        fileName: resolvedFileName,
        authHeader: downloadTarget.authHeader,
        onProgress: (written, expected) => {
          if (expected <= 0) {
            return;
          }
          const elapsed = (Date.now() - downloadStartTime) / 1000;
          const speed = elapsed > 0 ? written / elapsed : 0;
          get().updateProgress(id, {
            percent: written / expected,
            bytesWritten: written,
            totalBytes: expected,
            speed,
            eta: speed > 0 ? (expected - written) / speed : 0,
          });
        },
      });
      if (!result) {
        throw new Error(i18n.t("downloads.cancelled"));
      }

      get().completeDownload(id);

      if (await platform.isSharingAvailable()) {
        await platform.share(result.uri, {
          mimeType: tokenResponse.mimeType ?? undefined,
          dialogTitle: resolvedFileName
            ? i18n.t("downloads.shareFileNamed", { fileName: resolvedFileName })
            : i18n.t("downloads.shareFile"),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
      if (platform.isWeb) {
        console.warn("[DownloadStore] Download failed:", message);
        get().failDownload(id, message);
        return;
      }
      get().failDownload(id, message);
    }
  },

  cancelDownload: (id) => {
    downloadAbortControllers.get(id)?.abort();
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

/**
 * The HTTP download route is only reachable over a direct TCP connection. Returns `null` when
 * the connection in use is anything else (relay, SSH, socket, pipe, or none yet), so the caller
 * reads the file over the session socket instead.
 */
function resolveDaemonDownloadTarget(
  daemon: HostProfile | undefined,
  activeConnectionId: string | null,
): DownloadTarget | null {
  const connection = daemon?.connections.find((conn) => conn.id === activeConnectionId);
  if (connection?.type !== "directTcp") {
    return null;
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
/**
 * Saves bytes read over the session. Web and Electron hand them to the browser's download
 * manager and return `null`; native writes the file and returns its URI for the share sheet.
 */
async function saveDownloadedBytes(
  platform: DownloadPlatform,
  { bytes, fileName, mimeType }: DownloadedBytes,
): Promise<string | null> {
  if (platform.isWeb) {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const url = URL.createObjectURL(
      new Blob([buffer], { type: mimeType ?? "application/octet-stream" }),
    );
    platform.deliverToBrowser(url, fileName);
    // The browser may still be reading the blob while its save prompt is open.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  }
  const cacheFile = platform.createCacheFile(fileName);
  try {
    cacheFile.write(bytes);
    return cacheFile.uri;
  } finally {
    cacheFile.close();
  }
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
