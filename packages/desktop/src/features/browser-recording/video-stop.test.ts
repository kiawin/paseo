import { describe, expect, it, vi } from "vitest";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";

function setup() {
  const registry = new PaseoBrowserWebviewRegistry();
  registry.registerWebContents({ browserId: "root", webContentsId: 101, hostWebContentsId: 10 });
  registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
  const coordinator = new BrowserRecordingCoordinator(registry, () => false);
  const close = vi.fn(async () => {});
  coordinator.start({
    recordingId: "recording",
    hostWebContentsId: 10,
    browserId: "root",
    sink: { write: async () => {}, close },
  });
  return { coordinator, close };
}

describe("recording stop participants", () => {
  it("waits for video flushing before closing the sink and shares the stop promise", async () => {
    const { coordinator, close } = setup();
    let finish!: () => void;
    const flush = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const participant = vi.fn(() => flush);
    coordinator.subscribeStop(participant);
    const stopped = coordinator.stop("recording");
    expect(coordinator.stop("recording")).toBe(stopped);
    expect(participant).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    finish();
    await stopped;
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the sink and reports a failed final video write", async () => {
    const { coordinator, close } = setup();
    coordinator.subscribeStop(async () => {
      throw new Error("video write failed");
    });
    await expect(coordinator.stop("recording")).rejects.toThrow("video write failed");
    expect(close).toHaveBeenCalledOnce();
  });
});
