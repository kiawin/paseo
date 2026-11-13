import { describe, expect, it, vi } from "vitest";
import * as browserRegistry from "../browser-webviews/registry.js";
import type {
  BrowserRecordingCoordinator as CoordinatorType,
  RecordingEventSink,
} from "./coordinator.js";

const { PaseoBrowserWebviewRegistry } = browserRegistry;
const { BrowserRecordingCoordinator } = browserRegistry as typeof browserRegistry & {
  BrowserRecordingCoordinator: typeof CoordinatorType;
};

function register(
  registry: InstanceType<typeof PaseoBrowserWebviewRegistry>,
  browserId: string,
  webContentsId: number,
  hostWebContentsId = 10,
  workspaceId = "workspace-a",
) {
  registry.registerWebContents({ browserId, webContentsId, hostWebContentsId });
  registry.registerWorkspace({ browserId, workspaceId });
}

function setup() {
  const registry = new PaseoBrowserWebviewRegistry();
  register(registry, "root", 101);
  const sink: RecordingEventSink = { write: vi.fn(async () => {}) };
  const popupOpeners = new Map([
    [103, 102],
    [105, 103],
  ]);
  const coordinator = new BrowserRecordingCoordinator(
    registry,
    (opener, popup) => popupOpeners.get(popup) === opener,
  );
  const root = coordinator.start({
    recordingId: "recording-1",
    hostWebContentsId: 10,
    browserId: "root",
    sink,
  });
  return { coordinator, registry, root, sink };
}

describe("browser recording membership", () => {
  it("includes explicitly opened tabs and nested popups but excludes unrelated shared-profile guests", () => {
    const { coordinator, registry, root } = setup();
    register(registry, "unrelated", 104);
    const pending = coordinator.reserveTabOpen(101);
    register(registry, pending.browserId, 102);
    const child = coordinator.claimTabOpen({
      token: pending.token,
      hostWebContentsId: 10,
      browserId: pending.browserId,
    });
    const popup = coordinator.addPopupFromOpen({
      openerWebContentsId: 102,
      popupWebContentsId: 103,
    });
    const nested = coordinator.addPopupFromOpen({
      openerWebContentsId: 103,
      popupWebContentsId: 105,
    });

    expect(child.parentMemberId).toBe(root.memberId);
    expect(popup.parentMemberId).toBe(child.memberId);
    expect(nested.parentMemberId).toBe(popup.memberId);
    expect(coordinator.getMembership(104)).toBeNull();
    expect(() =>
      coordinator.addPopupFromOpen({ openerWebContentsId: 104, popupWebContentsId: 106 }),
    ).toThrow();
    expect(() =>
      coordinator.addPopupFromOpen({ openerWebContentsId: 101, popupWebContentsId: 106 }),
    ).toThrow();
    expect(() =>
      coordinator.claimTabOpen({
        token: pending.token,
        hostWebContentsId: 10,
        browserId: "unrelated",
      }),
    ).toThrow();
  });

  it("rejects forged root ownership and tabs from another window or workspace", () => {
    const { coordinator, registry } = setup();
    register(registry, "other-window", 201, 11);
    register(registry, "other-workspace", 202, 10, "workspace-b");
    expect(() =>
      coordinator.start({
        recordingId: "other",
        hostWebContentsId: 11,
        browserId: "root",
        sink: { write: vi.fn() },
      }),
    ).toThrow();
    const first = coordinator.reserveTabOpen(101);
    expect(() =>
      coordinator.claimTabOpen({
        token: first.token,
        hostWebContentsId: 11,
        browserId: "other-window",
      }),
    ).toThrow();
    const second = coordinator.reserveTabOpen(101);
    expect(() =>
      coordinator.claimTabOpen({
        token: second.token,
        hostWebContentsId: 10,
        browserId: "other-workspace",
      }),
    ).toThrow();
    expect(coordinator.getMembership(201)).toBeNull();
    expect(coordinator.getMembership(202)).toBeNull();
  });

  it("preserves a browser member identity when its registered guest is replaced", async () => {
    const { coordinator, registry, root, sink } = setup();
    coordinator.registerFrame({ webContentsId: 101, frameId: "frame-1", documentId: "document-1" });
    register(registry, "root", 301);
    await expect(
      coordinator.emit({ webContentsId: 101, kind: "network", payload: {} }),
    ).resolves.toEqual({ ok: false, reason: "stale-member" });
    expect(coordinator.getFrame({ webContentsId: 101, frameId: "frame-1" })).toBeNull();
    expect(() => coordinator.reserveTabOpen(101)).toThrow();
    expect(() =>
      coordinator.start({
        recordingId: "overlap",
        hostWebContentsId: 10,
        browserId: "root",
        sink,
      }),
    ).toThrow();
    const replacement = coordinator.replaceBrowserGuest({
      hostWebContentsId: 10,
      browserId: "root",
    });
    expect(replacement.memberId).toBe(root.memberId);
    expect(coordinator.getMembership(101)).toBeNull();
    expect(coordinator.getMembership(301)?.recordingId).toBe("recording-1");
    expect(coordinator.getFrame({ webContentsId: 101, frameId: "frame-1" })).toBeNull();
  });

  it("routes events only from current registered frames and stops after recording ends", async () => {
    const { coordinator, sink } = setup();
    coordinator.registerFrame({ webContentsId: 101, frameId: "frame-1", documentId: "document-1" });
    coordinator.registerFrame({ webContentsId: 101, frameId: "frame-1", documentId: "document-2" });
    await expect(
      coordinator.emit({
        webContentsId: 101,
        frameId: "frame-1",
        documentId: "document-1",
        kind: "network",
        payload: { url: "old" },
      }),
    ).resolves.toEqual({ ok: false, reason: "stale-document" });
    await expect(
      coordinator.emit({
        webContentsId: 101,
        frameId: "frame-1",
        documentId: "document-2",
        kind: "interaction",
        payload: { label: "click" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(sink.write).toHaveBeenCalledTimes(2);
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({ reason: "stale-document" }),
      }),
    );
    expect(coordinator.getDropCount("recording-1", 101)).toBe(1);
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: "recording-1",
        webContentsId: 101,
        frameId: "frame-1",
        documentId: "document-2",
        kind: "interaction",
      }),
    );
    await coordinator.stop("recording-1");
    await expect(
      coordinator.emit({
        webContentsId: 101,
        frameId: "frame-1",
        documentId: "document-2",
        kind: "media",
        payload: {},
      }),
    ).resolves.toEqual({ ok: false, reason: "unknown-contents" });
  });

  it("waits for admitted writes to settle when stopping a recording", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    register(registry, "root", 101);
    let finishWrite!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const coordinator = new BrowserRecordingCoordinator(registry, () => false);
    coordinator.start({
      recordingId: "recording-1",
      hostWebContentsId: 10,
      browserId: "root",
      sink: { write: () => pending },
    });
    const writing = coordinator.emit({ webContentsId: 101, kind: "network", payload: {} });
    const stopped = coordinator.stop("recording-1");
    const stoppedAgain = coordinator.stop("recording-1");
    expect(stoppedAgain).toBe(stopped);
    expect(() =>
      coordinator.start({
        recordingId: "recording-1",
        hostWebContentsId: 10,
        browserId: "root",
        sink: { write: async () => {} },
      }),
    ).toThrow();
    let finished = false;
    void stopped.then(() => {
      finished = true;
      return undefined;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    await expect(
      coordinator.emit({ webContentsId: 101, kind: "network", payload: {} }),
    ).resolves.toEqual({ ok: false, reason: "unknown-contents" });
    finishWrite();
    await expect(writing).resolves.toEqual({ ok: true });
    await expect(stopped).resolves.toBeUndefined();
    await expect(stoppedAgain).resolves.toBeUndefined();
  });

  it("does not let pre-existing tabs claim a fresh reservation and consumes failed claims", () => {
    const { coordinator, registry } = setup();
    register(registry, "unrelated", 104);
    const pending = coordinator.reserveTabOpen(101);
    expect(() =>
      coordinator.claimTabOpen({
        token: pending.token,
        hostWebContentsId: 10,
        browserId: "unrelated",
      }),
    ).toThrow();
    register(registry, pending.browserId, 102);
    expect(() =>
      coordinator.claimTabOpen({
        token: pending.token,
        hostWebContentsId: 10,
        browserId: pending.browserId,
      }),
    ).toThrow();
    expect(coordinator.getMembership(104)).toBeNull();
  });

  it("bounds and expires pending tab reservations", () => {
    const registry = new PaseoBrowserWebviewRegistry();
    register(registry, "root", 101);
    let now = 100;
    const coordinator = new BrowserRecordingCoordinator(registry, () => false, {
      now: () => now,
      maxPendingTabs: 1,
      pendingTabTtlMs: 10,
    });
    coordinator.start({
      recordingId: "rec",
      hostWebContentsId: 10,
      browserId: "root",
      sink: { write: vi.fn(async () => {}) },
    });
    const expired = coordinator.reserveTabOpen(101);
    expect(() => coordinator.reserveTabOpen(101)).toThrow();
    now += 11;
    register(registry, expired.browserId, 102);
    expect(() =>
      coordinator.claimTabOpen({
        token: expired.token,
        hostWebContentsId: 10,
        browserId: expired.browserId,
      }),
    ).toThrow();
    expect(coordinator.reserveTabOpen(101).token).toBeTruthy();
  });

  it("uses trusted attribution even when a producer supplies forged extra fields", async () => {
    const { coordinator, root, sink } = setup();
    const forged = {
      webContentsId: 101,
      kind: "network" as const,
      payload: {},
      recordingId: "forged",
      memberId: "forged",
    };
    await expect(coordinator.emit(forged)).resolves.toEqual({ ok: true });
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: "recording-1", memberId: root.memberId }),
    );
  });

  it("removes closed popup frames and interrupts the recording when its root closes", async () => {
    const { coordinator, registry, sink } = setup();
    const pending = coordinator.reserveTabOpen(101);
    register(registry, pending.browserId, 102);
    coordinator.claimTabOpen({
      token: pending.token,
      hostWebContentsId: 10,
      browserId: pending.browserId,
    });
    coordinator.addPopupFromOpen({ openerWebContentsId: 102, popupWebContentsId: 103 });
    coordinator.registerFrame({
      webContentsId: 103,
      frameId: "popup-frame",
      documentId: "popup-doc",
    });
    await coordinator.removeMember(103, "closed");
    expect(coordinator.getMembership(103)).toBeNull();
    expect(coordinator.getFrame({ webContentsId: 103, frameId: "popup-frame" })).toBeNull();
    expect(() =>
      coordinator.addPopupFromOpen({ openerWebContentsId: 102, popupWebContentsId: 103 }),
    ).toThrow();
    await coordinator.handleBrowserUnregistered({ hostWebContentsId: 10, browserId: "root" });
    expect(coordinator.getMembership(101)).toBeNull();
    expect(coordinator.getMembership(102)).toBeNull();
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({ reason: "root-closed" }),
      }),
    );
  });

  it("rejects empty attribution and persists sink failures through repeated stops", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    register(registry, "root", 101);
    const failure = new Error("sink failed");
    const close = vi.fn(async () => {});
    const coordinator = new BrowserRecordingCoordinator(registry, () => false);
    coordinator.start({
      recordingId: "rec",
      hostWebContentsId: 10,
      browserId: "root",
      sink: { write: vi.fn().mockRejectedValue(failure), close },
    });
    await expect(
      coordinator.emit({ webContentsId: 101, frameId: "", kind: "network", payload: {} }),
    ).rejects.toThrow("sink failed");
    await expect(coordinator.stop("rec")).rejects.toThrow("sink failed");
    await expect(coordinator.stop("rec")).rejects.toThrow("sink failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns drop reasons and writes a gap only for attributable members", async () => {
    const { coordinator, sink } = setup();
    await expect(
      coordinator.emit({ webContentsId: 999, kind: "network", payload: {} }),
    ).resolves.toEqual({ ok: false, reason: "unknown-contents" });
    expect(sink.write).not.toHaveBeenCalled();
    await expect(
      coordinator.emit({ webContentsId: 101, frameId: "", kind: "network", payload: {} }),
    ).resolves.toEqual({ ok: false, reason: "invalid-attribution" });
    await expect(
      coordinator.emit({
        webContentsId: 101,
        frameId: "new-frame",
        documentId: "new-document",
        kind: "network",
        payload: {},
      }),
    ).resolves.toEqual({ ok: false, reason: "unregistered-frame" });
    expect(coordinator.getDropCount("recording-1", 101)).toBe(2);
    expect(sink.write).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated gaps while retaining sample frame attribution and a final count", async () => {
    const { coordinator, sink } = setup();
    for (let index = 0; index < 10; index += 1) {
      await coordinator.emit({
        webContentsId: 101,
        frameId: `unknown-${index}`,
        documentId: "document",
        kind: "network",
        payload: {},
      });
    }
    expect(coordinator.getDropCount("recording-1", 101)).toBe(10);
    expect(sink.write).toHaveBeenCalledOnce();
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({
          reason: "unregistered-frame",
          sampleFrameId: "unknown-0",
          sampleDocumentId: "document",
        }),
      }),
    );
    await coordinator.stop("recording-1");
    expect(sink.write).toHaveBeenCalledTimes(2);
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({
          count: 10,
          summary: true,
          firstAtMs: expect.any(Number),
          lastAtMs: expect.any(Number),
        }),
      }),
    );
  });

  it("bounds gap groups and records first and last occurrence times", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    register(registry, "root", 101);
    let now = 100;
    const sink: RecordingEventSink = { write: vi.fn(async () => {}) };
    const coordinator = new BrowserRecordingCoordinator(registry, () => false, { now: () => now });
    const root = coordinator.start({
      recordingId: "rec",
      hostWebContentsId: 10,
      browserId: "root",
      sink,
    });
    for (let index = 0; index < 70; index += 1) {
      now += 1;
      await coordinator.reportGap({
        recordingId: "rec",
        memberId: root.memberId,
        reason: `reason-${index}`,
      });
    }
    expect(sink.write).toHaveBeenCalledTimes(65);
    await coordinator.stop("rec");
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({
          reason: "gap-overflow",
          count: 6,
          firstAtMs: 165,
          lastAtMs: 170,
          summary: true,
        }),
      }),
    );
  });

  it("bounds remembered sink failures and explicitly marks unattributed events", async () => {
    const { coordinator, sink } = setup();
    await coordinator.emit({ webContentsId: 101, kind: "network", payload: {} });
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({ frameAttribution: "unattributed" }),
    );
    const registry = new PaseoBrowserWebviewRegistry();
    register(registry, "root", 201);
    const failing = new BrowserRecordingCoordinator(registry, () => false);
    failing.start({
      recordingId: "failed",
      hostWebContentsId: 10,
      browserId: "root",
      sink: { write: vi.fn().mockRejectedValue(new Error("disk failed")) },
    });
    for (let index = 0; index < 105; index += 1) {
      await expect(
        failing.emit({ webContentsId: 201, kind: "network", payload: {} }),
      ).rejects.toThrow("disk failed");
    }
    const failure = await failing.stop("failed").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(100);
    expect((failure as Error).message).toContain("105");
  });

  it("notifies membership changes and closes sessions when their host closes", async () => {
    const { coordinator, registry, root } = setup();
    const changes = vi.fn();
    const unsubscribe = coordinator.subscribe(changes);
    const pending = coordinator.reserveTabOpen(101);
    register(registry, pending.browserId, 102);
    const child = coordinator.claimTabOpen({
      token: pending.token,
      hostWebContentsId: 10,
      browserId: pending.browserId,
    });
    expect(coordinator.listMemberships("recording-1")).toHaveLength(2);
    register(registry, "root", 301);
    coordinator.replaceBrowserGuest({ hostWebContentsId: 10, browserId: "root" });
    expect(changes).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "added",
        member: expect.objectContaining({ memberId: child.memberId }),
      }),
    );
    expect(changes).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "replaced",
        previousWebContentsId: 101,
        member: expect.objectContaining({ memberId: root.memberId }),
      }),
    );
    await coordinator.handleHostClosed(10);
    expect(coordinator.listMemberships("recording-1")).toEqual([]);
    expect(coordinator.getMembership(301)).toBeNull();
    unsubscribe();
  });

  it("lets trusted hooks report a gap for a member without a current guest", async () => {
    const { coordinator, registry, root, sink } = setup();
    register(registry, "root", 301);
    await expect(
      coordinator.reportGap({
        recordingId: "recording-1",
        memberId: root.memberId,
        reason: "replacement-failed",
      }),
    ).resolves.toBe(true);
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({ reason: "replacement-failed" }),
      }),
    );
    await expect(
      coordinator.reportGap({
        recordingId: "recording-1",
        memberId: "unrelated",
        reason: "forged",
      }),
    ).resolves.toBe(false);
  });

  it("records a gap when a known browser replacement cannot be resolved", async () => {
    const { coordinator, registry, sink } = setup();
    registry.unregisterBrowserFromHost(10, "root");
    expect(() =>
      coordinator.replaceBrowserGuest({ hostWebContentsId: 10, browserId: "root" }),
    ).toThrow();
    await coordinator.stop("recording-1");
    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gap",
        payload: expect.objectContaining({ reason: "replacement-failed" }),
      }),
    );
  });

  it("closes all sessions for a host even when one sink fails", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    register(registry, "first", 101);
    register(registry, "second", 102);
    const coordinator = new BrowserRecordingCoordinator(registry, () => false);
    coordinator.start({
      recordingId: "first-rec",
      hostWebContentsId: 10,
      browserId: "first",
      sink: { write: vi.fn().mockRejectedValue(new Error("disk failed")) },
    });
    coordinator.start({
      recordingId: "second-rec",
      hostWebContentsId: 10,
      browserId: "second",
      sink: { write: vi.fn(async () => {}) },
    });
    await expect(coordinator.handleHostClosed(10)).rejects.toThrow("cleanup failed");
    expect(coordinator.getMembership(101)).toBeNull();
    expect(coordinator.getMembership(102)).toBeNull();
  });
});
