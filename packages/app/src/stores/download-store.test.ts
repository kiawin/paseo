import { beforeEach, describe, expect, test, vi } from "vitest";

const writtenChunks: Uint8Array[] = [];
const createdNames: string[] = [];
const deletedNames: string[] = [];
const shareCalls: string[] = [];
let handleClosed = false;

vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));

vi.mock("expo-file-system", () => {
  class FakeFile {
    readonly uri: string;
    exists = false;
    constructor(_directory: unknown, name: string) {
      this.uri = `file:///cache/${name}`;
      createdNames.push(name);
    }
    create() {
      this.exists = true;
    }
    delete() {
      deletedNames.push(this.uri);
      this.exists = false;
    }
    open() {
      return {
        writeBytes: (bytes: Uint8Array) => writtenChunks.push(bytes),
        close: () => {
          handleClosed = true;
        },
      };
    }
  }
  return { File: FakeFile, Paths: { cache: "/cache", document: "/document" } };
});

vi.mock("expo-file-system/legacy", () => ({
  createDownloadResumable: () => ({ downloadAsync: async () => ({ uri: "file:///cache/x" }) }),
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => true,
  shareAsync: async (uri: string) => {
    shareCalls.push(uri);
  },
}));

vi.mock("@/i18n/i18next", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: async () => {} }));
vi.mock("@/utils/daemon-endpoints", () => ({ buildDaemonWebSocketUrl: () => "ws://host/ws" }));

const { useDownloadStore } = await import("./download-store");

function resetStore() {
  writtenChunks.length = 0;
  createdNames.length = 0;
  deletedNames.length = 0;
  shareCalls.length = 0;
  handleClosed = false;
  useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
}

describe("download store binary-channel path", () => {
  beforeEach(resetStore);

  test("streams chunks to disk and never asks for an HTTP token", async () => {
    const requestFileDownloadToken = vi.fn();

    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "notes.txt",
      path: "notes.txt",
      daemonProfile: undefined,
      requestFileDownloadToken,
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 6 });
        await sink.onChunk(new TextEncoder().encode("abc"));
        await sink.onChunk(new TextEncoder().encode("def"));
        return { fileName: "notes.txt", mimeType: "text/plain", size: 6 };
      },
    });

    expect(requestFileDownloadToken).not.toHaveBeenCalled();
    expect(writtenChunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["abc", "def"]);
    expect(handleClosed).toBe(true);
    expect(shareCalls).toEqual(["file:///cache/notes.txt"]);

    const download = [...useDownloadStore.getState().downloads.values()][0];
    expect(download.status).toBe("complete");
    expect(download.progress).toMatchObject({ bytesWritten: 6, totalBytes: 6, percent: 1 });
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
      requestFileDownloadToken,
    });

    expect(requestFileDownloadToken).toHaveBeenCalledWith("notes.txt");
    const download = [...useDownloadStore.getState().downloads.values()][0];
    expect(download.status).toBe("error");
  });

  test("closes the file handle and reports failure when the transfer aborts", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "big.bin",
      path: "big.bin",
      daemonProfile: undefined,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 100 });
        await sink.onChunk(new Uint8Array([1, 2, 3]));
        throw new Error("The host cancelled this transfer.");
      },
    });

    expect(handleClosed).toBe(true);
    const download = [...useDownloadStore.getState().downloads.values()][0];
    expect(download.status).toBe("error");
    expect(download.message).toBe("The host cancelled this transfer.");
  });

  test("treats an unknown archive size as indeterminate progress", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "src.zip",
      path: "src",
      daemonProfile: undefined,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 0, sizeKnown: false });
        await sink.onChunk(new Uint8Array(64));
        return { fileName: "src.zip", mimeType: "application/zip", size: null };
      },
    });

    const download = [...useDownloadStore.getState().downloads.values()][0];
    expect(download.status).toBe("complete");
    expect(download.progress).toMatchObject({
      bytesWritten: 64,
      totalBytes: 0,
      percent: 0,
      eta: 0,
    });
  });

  test("names the cache file from FileBegin so an archive keeps its extension", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      // A folder download is requested by folder name...
      fileName: "site",
      path: "site",
      daemonProfile: undefined,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        // ...but the daemon says what it actually is.
        sink.onBegin?.({ size: 0, sizeKnown: false, fileName: "site.zip" });
        await sink.onChunk(new Uint8Array([1, 2, 3]));
        return { fileName: "site.zip", mimeType: "application/zip", size: null };
      },
    });

    expect(createdNames).toContain("site.zip");
    expect(createdNames).not.toContain("site");
    expect(shareCalls).toEqual(["file:///cache/site.zip"]);
  });

  test("removes the partial cache file when a transfer fails", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "big.bin",
      path: "big.bin",
      daemonProfile: undefined,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 100 });
        await sink.onChunk(new Uint8Array([1, 2, 3]));
        throw new Error("The host cancelled this transfer.");
      },
    });

    expect(deletedNames).toEqual(["file:///cache/big.bin"]);
    const download = [...useDownloadStore.getState().downloads.values()][0];
    expect(download.status).toBe("error");
  });

  test("cancelling an in-flight download aborts the signal the client is given", async () => {
    let seenSignal: AbortSignal | undefined;
    let aborted = false;

    const started = useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "big.bin",
      path: "big.bin",
      daemonProfile: undefined,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink, signal }) => {
        seenSignal = signal;
        sink.onBegin?.({ size: 1000 });
        await sink.onChunk(new Uint8Array(10));
        // Stay in flight until the store aborts us, as a real transfer would.
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
    const inFlight = [...useDownloadStore.getState().downloads.values()][0];
    expect(inFlight.status).toBe("downloading");
    expect(seenSignal).toBeDefined();

    useDownloadStore.getState().cancelDownload(inFlight.id);
    await started;

    expect(aborted).toBe(true);
    const download = [...useDownloadStore.getState().downloads.values()][0];
    expect(download.status).toBe("error");
  });
});
