import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import { i18n } from "@/i18n/i18next";
import {
  MAX_SESSION_DOWNLOAD_BYTES,
  useDownloadStore,
  type Download,
  type DownloadedBytes,
} from "@/stores/download-store";
import type {
  DirectTcpHostConnection,
  HostProfile,
  RelayHostConnection,
} from "@/types/host-connection";
import { createFakeDownloadPlatform, type FakeDownloadPlatform } from "./download-platform-fake";

// No module mocks: the store takes its filesystem and sharing through an injected port.

let platform: FakeDownloadPlatform;

const FILE_BYTES = new TextEncoder().encode("relay download payload");
const FILE_PATH = "reports/données été.bin";
const FILE_NAME = "données été.bin";
const MIME_TYPE = "application/octet-stream";

const relayConnection: RelayHostConnection = {
  id: "relay:relay.paseo.sh:443",
  type: "relay",
  relayEndpoint: "relay.paseo.sh:443",
  daemonPublicKeyB64: "cHVibGljLWtleQ==",
};

// The #3753 shape: the relay hostname stored as a directTcp entry that nothing can reach.
const staleTcpConnection: DirectTcpHostConnection = {
  id: "direct:relay.paseo.sh:443",
  type: "directTcp",
  endpoint: "relay.paseo.sh:443",
};

const localTcpConnection: DirectTcpHostConnection = {
  id: "direct:localhost:6767",
  type: "directTcp",
  endpoint: "localhost:6767",
};

function profileWith(connections: HostProfile["connections"]): HostProfile {
  return {
    serverId: "srv_remote",
    label: "Remote",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createTokenRequest(size: number | null = FILE_BYTES.byteLength) {
  const requested: string[] = [];
  return {
    requested,
    request: async (path: string) => {
      requested.push(path);
      return { token: "tok", fileName: FILE_NAME, mimeType: MIME_TYPE, size, error: null };
    },
  };
}

function createFileReader(read: () => Promise<{ bytes: Uint8Array; size: number }>) {
  const requested: string[] = [];
  return {
    requested,
    read: async (path: string) => {
      requested.push(path);
      return read();
    },
  };
}

function createFileSaver() {
  const savedFiles: DownloadedBytes[] = [];
  return {
    savedFiles,
    save: async (file: DownloadedBytes) => {
      savedFiles.push(file);
      return null;
    },
  };
}

interface StartInput {
  profile: HostProfile;
  activeConnectionId: string | null;
  token?: ReturnType<typeof createTokenRequest>;
  reader?: ReturnType<typeof createFileReader>;
  saver?: ReturnType<typeof createFileSaver>;
}

async function startDownload(input: StartInput): Promise<Download | undefined> {
  const token = input.token ?? createTokenRequest();
  const reader =
    input.reader ??
    createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }));
  const saver = input.saver ?? createFileSaver();
  await useDownloadStore.getState().startDownload({
    serverId: "srv_remote",
    scopeId: "workspace-1",
    fileName: FILE_NAME,
    path: FILE_PATH,
    daemonProfile: input.profile,
    activeConnectionId: input.activeConnectionId,
    requestFileDownloadToken: token.request,
    readFile: reader.read,
    saveFile: saver.save,
    platform,
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  return activeDownloadId ? downloads.get(activeDownloadId) : undefined;
}

describe("download store transport selection", () => {
  beforeEach(() => {
    platform = createFakeDownloadPlatform();
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  it("downloads over the session when the active connection is the relay", async () => {
    const token = createTokenRequest();
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      token,
      reader,
      saver,
    });

    expect(download).toMatchObject({ fileName: FILE_NAME, status: "complete" });
    expect(token.requested).toEqual([FILE_PATH]);
    expect(reader.requested).toEqual([FILE_PATH]);
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);
  });

  it("bounds the session read even when the token reports a smaller file", async () => {
    const readRequests: Array<{ path: string; maxBytes: number }> = [];
    const saver = createFileSaver();
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      path: FILE_PATH,
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      platform,
      requestFileDownloadToken: createTokenRequest(1).request,
      readFile: async (path: string, maxBytes: number) => {
        readRequests.push({ path, maxBytes });
        return { bytes: FILE_BYTES, size: FILE_BYTES.byteLength };
      },
      saveFile: saver.save,
    });
    expect(readRequests).toEqual([{ path: FILE_PATH, maxBytes: MAX_SESSION_DOWNLOAD_BYTES }]);
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);
  });

  it("ignores a directTcp entry that is not the active connection", async () => {
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([staleTcpConnection, relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    expect(reader.requested).toEqual([FILE_PATH]);
    expect(saver.savedFiles).toHaveLength(1);
  });

  it("keeps the HTTP token download when the active connection is directTcp", async () => {
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([localTcpConnection, relayConnection]),
      activeConnectionId: localTcpConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    expect(reader.requested).toEqual([]);
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails the download and saves nothing when the session read fails", async () => {
    const reader = createFileReader(async () => {
      throw new Error("Connection lost");
    });
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "error", message: "Connection lost" });
    expect(saver.savedFiles).toEqual([]);
  });

  it("refuses a file over the session size limit before reading it", async () => {
    const token = createTokenRequest(MAX_SESSION_DOWNLOAD_BYTES + 1);
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      token,
      reader,
      saver,
    });

    expect(download).toMatchObject({
      status: "error",
      message: i18n.t("composer.errors.fileTooLarge", { fileName: FILE_NAME, size: "64 MB" }),
    });
    expect(download?.message).toContain("64 MB");
    expect(reader.requested).toEqual([]);
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails instead of saving an empty file when the daemon returns no content", async () => {
    const reader = createFileReader(async () => ({ bytes: new Uint8Array(), size: 6 }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({
      status: "error",
      message: "File transfer incomplete: expected 6 bytes, received 0.",
    });
    expect(saver.savedFiles).toEqual([]);
  });
});

function activeDownload() {
  return [...useDownloadStore.getState().downloads.values()][0];
}

describe("download store binary-channel path", () => {
  beforeEach(() => {
    platform = createFakeDownloadPlatform();
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  test("streams chunks to the cache file and never asks for an HTTP token", async () => {
    const requestFileDownloadToken = vi.fn();

    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "notes.txt",
      path: "notes.txt",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken,
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 6 });
        await sink.onChunk(new TextEncoder().encode("abc"));
        await sink.onChunk(new TextEncoder().encode("def"));
        return { fileName: "notes.txt", mimeType: "text/plain", size: 6 };
      },
    });

    expect(requestFileDownloadToken).not.toHaveBeenCalled();
    expect(platform.httpRequests).toEqual([]);
    expect(new TextDecoder().decode(platform.bytesFor("notes.txt"))).toBe("abcdef");
    expect(platform.shared).toEqual([{ uri: "file:///cache/notes.txt", mimeType: "text/plain" }]);
    expect(activeDownload()).toMatchObject({
      status: "complete",
      progress: { bytesWritten: 6, totalBytes: 6, percent: 1 },
    });
  });

  test("names the cache file from FileBegin so an archive keeps its extension", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "site",
      path: "site",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 0, sizeKnown: false, fileName: "site.zip" });
        await sink.onChunk(new Uint8Array([1, 2, 3]));
        return { fileName: "site.zip", mimeType: "application/zip", size: null };
      },
    });

    expect(platform.created).toEqual(["site.zip"]);
    expect(platform.shared[0]?.uri).toBe("file:///cache/site.zip");
  });

  test("treats an unknown archive size as indeterminate progress", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "src.zip",
      path: "src",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 0, sizeKnown: false });
        await sink.onChunk(new Uint8Array(64));
        return { fileName: "src.zip", mimeType: "application/zip", size: null };
      },
    });

    expect(activeDownload()).toMatchObject({
      status: "complete",
      progress: { bytesWritten: 64, totalBytes: 0, percent: 0, eta: 0 },
    });
  });

  test("removes the partial cache file when a transfer fails", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "big.bin",
      path: "big.bin",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 100 });
        await sink.onChunk(new Uint8Array([1, 2, 3]));
        throw new Error("The host cancelled this transfer.");
      },
    });

    expect(platform.removed).toEqual(["big.bin"]);
    expect(activeDownload()).toMatchObject({
      status: "error",
      message: "The host cancelled this transfer.",
    });
  });

  test("cancelling an in-flight download aborts the signal the client is given", async () => {
    let aborted = false;

    const started = useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "big.bin",
      path: "big.bin",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink, signal }) => {
        sink.onBegin?.({ size: 1000 });
        await sink.onChunk(new Uint8Array(10));
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        throw new Error("Download cancelled.");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(activeDownload().status).toBe("downloading");

    useDownloadStore.getState().cancelDownload(activeDownload().id);
    await started;

    expect(aborted).toBe(true);
    expect(activeDownload().status).toBe("error");
  });

  test("falls back to the HTTP token path when the host lacks the feature", async () => {
    const requestFileDownloadToken = vi.fn().mockResolvedValue({
      token: null,
      fileName: null,
      mimeType: null,
      error: "nope",
    });

    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "notes.txt",
      path: "notes.txt",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken,
    });

    expect(requestFileDownloadToken).toHaveBeenCalledWith("notes.txt");
    expect(platform.created).toEqual([]);
    expect(activeDownload().status).toBe("error");
  });
});
