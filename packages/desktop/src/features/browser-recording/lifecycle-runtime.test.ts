import { describe, expect, it, vi } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";

const fake = vi.hoisted(() => ({
  contents: new Map<number, unknown>(),
  enable: vi.fn(),
  errors: [] as unknown[],
}));
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  webContents: { fromId: (id: number) => fake.contents.get(id) ?? null },
}));
vi.mock("../browser-automation/ipc.js", () => ({
  getSharedCdpSession: () => ({
    createConsumer: () => ({
      enableDomain: fake.enable,
      enableAutoAttach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({ frameTree: {} }),
      release: vi.fn().mockResolvedValue(undefined),
    }),
  }),
}));
import { createBrowserRecordingLifecycle } from "./lifecycle.js";

describe("interaction Runtime setup", () => {
  it("reports Runtime failure while retaining network and page setup", async () => {
    fake.contents.clear();
    fake.enable.mockReset();
    fake.errors.length = 0;
    fake.enable.mockImplementation(async (domain: string) => {
      if (domain === "Runtime") throw new Error("runtime failed");
    });
    const contents = { id: 10, isDestroyed: () => false, once: vi.fn(), on: vi.fn() };
    fake.contents.set(contents.id, contents);
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({ browserId: "root", webContentsId: 10, hostWebContentsId: 1 });
    registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
    const sink = { write: vi.fn(async () => {}) };
    const lifecycle = createBrowserRecordingLifecycle({
      registry,
      onTabOpen: () => {},
      onPopup: () => {},
      onError: (error) => fake.errors.push(error),
    });
    lifecycle.coordinator.start({
      recordingId: "recording",
      hostWebContentsId: 1,
      browserId: "root",
      sink,
    });
    await lifecycle.ready(contents.id);
    expect(fake.enable).toHaveBeenCalledWith("Network", undefined, {
      maxTotalBufferSize: 4 * 1024 * 1024,
      maxResourceBufferSize: 512 * 1024,
      maxPostDataSize: 256 * 1024,
    });
    expect(fake.enable).toHaveBeenCalledWith("Page");
    expect(fake.enable).toHaveBeenCalledWith("Runtime", undefined);
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({ reason: "interaction-runtime-unavailable" }),
      }),
    );
    expect(fake.errors).toHaveLength(1);
    await lifecycle.coordinator.stop("recording");
  });
});
