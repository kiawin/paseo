import { expect, it, vi } from "vitest";
import { createRecordingsModel } from "./model";

it("surfaces invalid metadata, paginates media and retains a selected recording when deletion fails", async () => {
  const host = {
    list: vi.fn(async () => ({
      recordings: [{ recordingId: "bad", workspaceId: "ws", startedAt: 1, status: "unexpected" }],
      incomplete: [],
    })),
    readEvents: vi.fn(async () => ({ events: [], nextCursor: null, incompleteTail: false })),
    listMedia: vi.fn(async ({ cursor }: { cursor: string | null }) =>
      cursor === null
        ? {
            segments: [
              {
                streamId: "tab",
                segmentId: "a",
                startMs: 0,
                durationMs: 1,
                mimeType: "video/webm",
              },
            ],
            incomplete: [],
            nextCursor: "next",
          }
        : {
            segments: [
              {
                streamId: "tab",
                segmentId: "b",
                startMs: 1,
                durationMs: 1,
                mimeType: "video/webm",
              },
            ],
            incomplete: [{ reason: "damaged" }],
            nextCursor: null,
          },
    ),
    delete: vi.fn(async () => {
      throw new Error("copy still shared");
    }),
  };
  const model = createRecordingsModel(host, "ws", () => {});
  await model.refresh();
  expect(model.getState().incomplete).toContain("bad");
  expect(model.getState().recordings).toEqual([]);
  await model.open("bad");
  await model.loadMoreMedia();
  expect(model.getState().media.map((segment) => segment.segmentId)).toEqual(["a", "b"]);
  expect(model.getState().mediaIncomplete).toEqual([
    expect.objectContaining({ reason: "damaged" }),
  ]);
  await model.remove("bad");
  expect(model.getState()).toMatchObject({ selectedId: "bad", error: "copy still shared" });
  model.dispose();
});
