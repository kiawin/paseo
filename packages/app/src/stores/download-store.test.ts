import { beforeEach, describe, expect, test, vi } from "vitest";

const writtenChunks: Uint8Array[] = [];
const shareCalls: string[] = [];
let handleClosed = false;

vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));

vi.mock("expo-file-system", () => {
  class FakeFile {
    readonly uri: string;
    exists = false;
    constructor(_directory: unknown, name: string) {
      this.uri = `file:///cache/${name}`;
    }
    create() {
      this.exists = true;
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
});
