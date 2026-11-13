import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator } from "./coordinator.js";
import { BrowserRecordingStore } from "./store.js";
import { NetworkRecorder } from "./network-recorder.js";
import fixture from "./network-fixture.json";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-recording-coordinator-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("recording event storage", () => {
  it("persists reconstructed network data through the coordinator without loss", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create({
      recordingId: "recording",
      workspaceId: "workspace",
      startedAt: 1,
      status: "recording",
    });
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({ browserId: "root", webContentsId: 10, hostWebContentsId: 1 });
    registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
    const coordinator = new BrowserRecordingCoordinator(registry, () => false);
    coordinator.start({
      recordingId: "recording",
      hostWebContentsId: 1,
      browserId: "root",
      sink: { write: (event) => store.appendEvent("recording", event) },
    });
    const first = fixture.events[0].params;
    coordinator.registerFrame({
      webContentsId: 10,
      frameId: first.frameId!,
      documentId: first.loaderId!,
    });
    const recorder = new NetworkRecorder({
      getResponseBody: async () => fixture.body,
      write: async (transaction) => {
        const result = await coordinator.emit({
          webContentsId: 10,
          frameId: transaction.frameId ?? undefined,
          documentId: transaction.documentId ?? undefined,
          kind: "network",
          payload: transaction,
        });
        expect(result).toEqual({ ok: true });
      },
    });
    for (const event of fixture.events) await recorder.handle(event);
    await recorder.close();
    await coordinator.stop("recording");
    const result = await store.readEvents("recording");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "network",
      payload: {
        request: { body: { state: "complete", data: "probe-body" } },
        response: { body: { state: "complete", data: fixture.body.body } },
      },
    });
  });
  it("persists coordinator gaps without silently changing their JSON values", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create({
      recordingId: "recording",
      workspaceId: "workspace",
      startedAt: 1,
      status: "recording",
    });
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({ browserId: "root", webContentsId: 10, hostWebContentsId: 1 });
    registry.registerWorkspace({ browserId: "root", workspaceId: "workspace" });
    const coordinator = new BrowserRecordingCoordinator(registry, () => false);
    const member = coordinator.start({
      recordingId: "recording",
      hostWebContentsId: 1,
      browserId: "root",
      sink: { write: (event) => store.appendEvent("recording", event) },
    });
    await coordinator.reportGap({
      recordingId: "recording",
      memberId: member.memberId,
      reason: "fixture-gap",
    });
    await coordinator.stop("recording");
    const result = await store.readEvents("recording");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "gap",
      payload: { reason: "fixture-gap", count: 1 },
    });
    expect(result.incompleteTail).toBe(false);
  });
});
