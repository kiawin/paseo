import { describe, expect, it, vi } from "vitest";

const load = () => import("./model");
function bridge() {
  return {
    list: vi.fn(async () => ({
      recordings: [
        { recordingId: "one", workspaceId: "w", status: "complete", startedAt: 1 },
        { recordingId: "two", workspaceId: "w", status: "interrupted", startedAt: 2 },
      ],
      incomplete: ["orphan"],
    })),
    readEvents: vi.fn(
      async ({ cursor }: { recordingId: string; cursor: number; maxBytes: number }) =>
        cursor === 0
          ? {
              events: [{ kind: "network", payload: { url: "<img onerror=alert(1)>" } }],
              nextCursor: 12,
              incompleteTail: false,
            }
          : {
              events: [{ kind: "gap", payload: { reason: "missing" } }],
              nextCursor: null,
              incompleteTail: true,
            },
    ),
    listMedia: vi.fn(async () => ({
      segments: [],
      incomplete: [{ reason: "interrupted" }],
      nextCursor: null,
    })),
    delete: vi.fn(async () => {}),
  };
}

describe("recordings pane model", () => {
  it("discards an old page after the user closes a recording", async () => {
    const { createRecordingsModel } = await load();
    const host = bridge();
    let resolve!: (value: Awaited<ReturnType<typeof host.readEvents>>) => void;
    host.readEvents.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const model = createRecordingsModel(host, "w", () => {});
    const pending = model.open("one");
    model.close();
    resolve({
      events: [{ kind: "gap", payload: { reason: "old" } }],
      nextCursor: null,
      incompleteTail: false,
    });
    await pending;
    expect(model.getState()).toMatchObject({ selectedId: null, events: [] });
  });
  it("surfaces active media as pending rather than missing", async () => {
    const { createRecordingsModel } = await load();
    const host = bridge();
    const original = host.listMedia;
    const model = createRecordingsModel(
      { ...host, listMedia: async () => ({ ...(await original()), pending: true }) },
      "w",
      () => {},
    );
    await model.open("one");
    expect(model.getState().mediaPending).toBe(true);
  });
  it("lists completed, interrupted and incomplete recordings", async () => {
    const { createRecordingsModel } = await load();
    const host = bridge();
    const model = createRecordingsModel(host, "w", () => {});
    await model.refresh();
    expect(host.list).toHaveBeenCalledWith({ workspaceId: "w" });
    expect(model.getState()).toMatchObject({
      recordings: [{ recordingId: "one" }, { recordingId: "two" }],
      incomplete: ["orphan"],
    });
  });
  it("loads bounded event pages and preserves incomplete media and event tail", async () => {
    const { createRecordingsModel } = await load();
    const host = bridge();
    const model = createRecordingsModel(host, "w", () => {});
    await model.open("two");
    expect(host.readEvents).toHaveBeenCalledWith({
      recordingId: "two",
      cursor: 0,
      maxBytes: 262144,
    });
    expect(model.getState().events[0].payload.url).toBe("<img onerror=alert(1)>");
    await model.loadMore();
    expect(host.readEvents).toHaveBeenLastCalledWith({
      recordingId: "two",
      cursor: 12,
      maxBytes: 262144,
    });
    expect(model.getState()).toMatchObject({
      eventTailIncomplete: true,
      mediaIncomplete: [{ reason: "interrupted" }],
    });
    expect(model.getState().events).toHaveLength(2);
  });
  it("deletes the selected recording then refreshes the list", async () => {
    const { createRecordingsModel } = await load();
    const host = bridge();
    const model = createRecordingsModel(host, "w", () => {});
    await model.open("two");
    await model.remove("two");
    expect(host.delete).toHaveBeenCalledWith({ recordingId: "two" });
    expect(host.list).toHaveBeenCalled();
    expect(model.getState().selectedId).toBeNull();
  });
});
