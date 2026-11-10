import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  appendFile,
  symlink,
  link,
  writeFile,
  mkdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as coordinator from "./coordinator.js";

interface Metadata {
  recordingId: string;
  schemaVersion?: number;
  workspaceId: string;
  startedAt: number;
  status: "recording" | "complete" | "interrupted";
  title?: string;
  endedAt?: number;
  captureErrors?: string[];
}
interface Event {
  recordingId: string;
  memberId: string;
  webContentsId: number;
  kind: "interaction";
  frameAttribution: "unattributed";
  payload: unknown;
}
interface Segment {
  streamId: string;
  segmentId: string;
  startMs: number;
  durationMs: number;
  mimeType: string;
  track?: "video" | "audio" | "combined";
  codec?: string;
  bytes: Uint8Array;
}
interface Store {
  create(input: Metadata): Promise<void>;
  readMetadata(id: string): Promise<Metadata>;
  updateMetadata(
    id: string,
    patch: Partial<Pick<Metadata, "status" | "title" | "endedAt" | "captureErrors">>,
  ): Promise<void>;
  appendEvent(id: string, event: Event): Promise<void>;
  readEvents(id: string): Promise<{ events: Event[]; incompleteTail: boolean }>;
  readEventsPage(
    id: string,
    input: { cursor: number; maxBytes: number },
  ): Promise<{ events: Event[]; nextCursor: number | null; incompleteTail: boolean }>;
  writeMediaSegment(id: string, segment: Segment): Promise<void>;
  readMediaSegment(id: string, streamId: string, segmentId: string): Promise<Segment>;
  readMediaSegmentRange(
    id: string,
    streamId: string,
    segmentId: string,
    input: { offset: number; length: number },
  ): Promise<{ bytes: Uint8Array; totalBytes: number; sha256: string }>;
  listMediaSegments(id: string): Promise<Array<Omit<Segment, "bytes">>>;
  listMediaSegmentsWithGaps(id: string): Promise<{
    segments: Array<Omit<Segment, "bytes">>;
    incomplete: Array<{ streamId: string | null; segmentId: string | null; reason: string }>;
  }>;
}
type StoreFactory = new (
  root: string,
  options?: {
    maxMediaSegmentBytes?: number;
    maxEventReadBytes?: number;
    maxQueuedBytes?: number;
    maxQueuedOperations?: number;
    maxEventBytes?: number;
  },
) => Store;
const { BrowserRecordingStore } = coordinator as typeof coordinator & {
  BrowserRecordingStore: StoreFactory;
};
let root: string;
const metadata: Metadata = {
  recordingId: "recording-1",
  workspaceId: "workspace-1",
  startedAt: 1234,
  status: "recording",
};
const event: Event = {
  recordingId: "recording-1",
  memberId: "member-1",
  webContentsId: 11,
  kind: "interaction",
  frameAttribution: "unattributed",
  payload: { element: "save", headers: { authorization: "synthetic" } },
};
const segment: Segment = {
  streamId: "tab-1",
  segmentId: "segment-1",
  startMs: 100,
  durationMs: 250,
  mimeType: "video/webm",
  bytes: Uint8Array.from([0, 255, 3, 9]),
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-recording-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("desktop recording store", () => {
  it("detects truncated or altered media and preserves track metadata", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    const tracked: Segment = { ...segment, track: "combined", codec: "vp9,opus" };
    await store.writeMediaSegment(metadata.recordingId, tracked);
    expect(
      await store.readMediaSegment(metadata.recordingId, tracked.streamId, tracked.segmentId),
    ).toEqual(tracked);
    const path = join(
      root,
      metadata.recordingId,
      "media",
      tracked.streamId,
      `${tracked.segmentId}.bin`,
    );
    const range = await store.readMediaSegmentRange(
      metadata.recordingId,
      tracked.streamId,
      tracked.segmentId,
      { offset: 0, length: 2 },
    );
    expect(range.sha256).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(path, Buffer.from([9, 9, 9, 9]));
    await expect(
      store.readMediaSegment(metadata.recordingId, tracked.streamId, tracked.segmentId),
    ).rejects.toThrow(/integrity/i);
    await writeFile(path, Buffer.from([9]));
    await expect(
      store.readMediaSegmentRange(metadata.recordingId, tracked.streamId, tracked.segmentId, {
        offset: 0,
        length: 1,
      }),
    ).rejects.toThrow(/range/i);
    expect((await store.listMediaSegmentsWithGaps(metadata.recordingId)).incomplete).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segmentId: tracked.segmentId,
          reason: "Media segment is unreadable",
        }),
      ]),
    );
  });
  it("preserves unknown JSON metadata across updates", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create({ ...metadata, futureField: { source: "future" } } as Metadata);
    await store.updateMetadata(metadata.recordingId, { title: "Updated" });
    expect(await store.readMetadata(metadata.recordingId)).toMatchObject({
      title: "Updated",
      futureField: { source: "future" },
    });
  });
  it.skipIf(process.platform === "win32")(
    "rejects an unrelated media hardlink without hiding other segments",
    async () => {
      const store = new BrowserRecordingStore(root);
      await store.create(metadata);
      await store.writeMediaSegment(metadata.recordingId, segment);
      await store.writeMediaSegment(metadata.recordingId, {
        ...segment,
        segmentId: "segment-2",
        startMs: 350,
      });
      const outside = join(root, "unexpected-hardlink");
      await link(
        join(root, metadata.recordingId, "media", segment.streamId, "segment-1.bin"),
        outside,
      );
      await expect(
        store.readMediaSegment(metadata.recordingId, segment.streamId, segment.segmentId),
      ).rejects.toThrow(/hardlink/i);
      const listing = await store.listMediaSegmentsWithGaps(metadata.recordingId);
      expect(listing.segments.map((item) => item.segmentId)).toEqual(["segment-2"]);
      expect(listing.incomplete).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            segmentId: "segment-1",
            reason: "Media segment file is unsafe",
          }),
        ]),
      );
      expect(await readFile(outside)).toEqual(Buffer.from(segment.bytes));
    },
  );
  it.skipIf(process.platform === "win32")(
    "reads a published segment after a crash left its temporary hardlink",
    async () => {
      const store = new BrowserRecordingStore(root);
      await store.create(metadata);
      await store.writeMediaSegment(metadata.recordingId, segment);
      const path = join(root, metadata.recordingId, "media", segment.streamId);
      const temporary = join(path, ".33333333-3333-4333-8333-333333333333.tmp");
      await link(join(path, "segment-1.bin"), temporary);
      const reopened = new BrowserRecordingStore(root);
      expect(
        (await reopened.readMediaSegment(metadata.recordingId, segment.streamId, segment.segmentId))
          .bytes,
      ).toEqual(segment.bytes);
      await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("persists a versioned recording's end time and capture errors", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await store.updateMetadata(metadata.recordingId, {
      status: "interrupted",
      endedAt: 2000,
      captureErrors: ["disk-full"],
    });
    expect(await store.readMetadata(metadata.recordingId)).toMatchObject({
      schemaVersion: 1,
      status: "interrupted",
      endedAt: 2000,
      captureErrors: ["disk-full"],
    });
  });
  it("reads bounded media byte ranges without loading a whole segment", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await store.writeMediaSegment(metadata.recordingId, segment);
    const range = await store.readMediaSegmentRange(
      metadata.recordingId,
      segment.streamId,
      segment.segmentId,
      { offset: 1, length: 2 },
    );
    expect(Array.from(range.bytes)).toEqual([255, 3]);
    expect(range.totalBytes).toBe(4);
    await expect(
      store.readMediaSegmentRange(metadata.recordingId, segment.streamId, segment.segmentId, {
        offset: -1,
        length: 2,
      }),
    ).rejects.toThrow();
    await expect(
      store.readMediaSegmentRange(metadata.recordingId, segment.streamId, segment.segmentId, {
        offset: 0,
        length: 4 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow();
  });
  it.skipIf(process.platform === "win32")(
    "recovers redundant crash links and lists intact segments beside incomplete files",
    async () => {
      const store = new BrowserRecordingStore(root);
      await store.create(metadata);
      await store.writeMediaSegment(metadata.recordingId, segment);
      await store.writeMediaSegment(metadata.recordingId, {
        ...segment,
        segmentId: "segment-2",
        startMs: 350,
      });
      const path = join(root, metadata.recordingId, "media", segment.streamId);
      const redundant = join(path, ".11111111-1111-4111-8111-111111111111.tmp");
      const interrupted = join(path, ".22222222-2222-4222-8222-222222222222.tmp");
      const redundantInfo = join(path, ".44444444-4444-4444-8444-444444444444.tmp");
      await link(join(path, "segment-1.bin"), redundant);
      await link(join(path, "segment-1.json"), redundantInfo);
      await writeFile(interrupted, "unfinished");
      await writeFile(join(path, "orphan.bin"), Buffer.from([7]));
      const listing = await store.listMediaSegmentsWithGaps(metadata.recordingId);
      expect(listing.segments.map((item) => item.segmentId)).toEqual(["segment-1", "segment-2"]);
      expect(listing.incomplete).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            segmentId: "orphan",
            reason: "Media segment metadata is missing",
          }),
          expect.objectContaining({ reason: "Interrupted media temporary file remains" }),
        ]),
      );
      expect((await stat(join(path, "segment-1.bin"))).nlink).toBe(1);
      await expect(stat(redundant)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(redundantInfo)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(interrupted, "utf8")).toBe("unfinished");
      expect(
        (await store.readMediaSegment(metadata.recordingId, segment.streamId, segment.segmentId))
          .bytes,
      ).toEqual(segment.bytes);
    },
  );
  it("pages through event logs that exceed the whole-file read limit", async () => {
    const store = new BrowserRecordingStore(root, { maxEventReadBytes: 128 });
    await store.create(metadata);
    for (let index = 0; index < 5; index++)
      await store.appendEvent(metadata.recordingId, {
        ...event,
        payload: { index, text: "x".repeat(120) },
      });
    await expect(store.readEvents(metadata.recordingId)).rejects.toThrow(/limit/i);
    let cursor: number | null = 0;
    const collected: Event[] = [];
    while (cursor !== null) {
      const page = await store.readEventsPage(metadata.recordingId, { cursor, maxBytes: 256 });
      collected.push(...page.events);
      expect(page.incompleteTail).toBe(false);
      cursor = page.nextCursor;
    }
    expect(collected.map((item) => (item.payload as { index: number }).index)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    await expect(
      store.readEventsPage(metadata.recordingId, { cursor: 2, maxBytes: 256 }),
    ).rejects.toThrow(/cursor/i);
  });
  it("persists metadata and event records across a new store instance", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await store.appendEvent(metadata.recordingId, event);
    await store.updateMetadata(metadata.recordingId, { title: "Checkout", status: "complete" });
    const reopened = new BrowserRecordingStore(root);
    expect(await reopened.readMetadata(metadata.recordingId)).toMatchObject({
      ...metadata,
      title: "Checkout",
      status: "complete",
    });
    expect(await reopened.readEvents(metadata.recordingId)).toEqual({
      events: [event],
      incompleteTail: false,
    });
  });
  it("stores immutable arbitrary media segments with their timeline metadata", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await store.writeMediaSegment(metadata.recordingId, segment);
    const second = {
      ...segment,
      segmentId: "segment-2",
      startMs: 350,
      bytes: Uint8Array.from([5, 4, 3]),
    };
    await store.writeMediaSegment(metadata.recordingId, second);
    const reopened = new BrowserRecordingStore(root);
    expect(
      await reopened.readMediaSegment(metadata.recordingId, segment.streamId, segment.segmentId),
    ).toEqual(segment);
    expect(await reopened.listMediaSegments(metadata.recordingId)).toEqual([
      {
        streamId: "tab-1",
        segmentId: "segment-1",
        startMs: 100,
        durationMs: 250,
        mimeType: "video/webm",
      },
      {
        streamId: "tab-1",
        segmentId: "segment-2",
        startMs: 350,
        durationMs: 250,
        mimeType: "video/webm",
      },
    ]);
    await expect(
      store.writeMediaSegment(metadata.recordingId, { ...segment, bytes: Uint8Array.of(99) }),
    ).rejects.toThrow();
    expect(
      (await reopened.readMediaSegment(metadata.recordingId, segment.streamId, segment.segmentId))
        .bytes,
    ).toEqual(segment.bytes);
  });
  it.skipIf(process.platform === "win32")(
    "uses owner-only permissions for directories and persisted files",
    async () => {
      const store = new BrowserRecordingStore(root);
      await store.create(metadata);
      await store.appendEvent(metadata.recordingId, event);
      await store.writeMediaSegment(metadata.recordingId, segment);
      for (const dir of [
        root,
        join(root, metadata.recordingId),
        join(root, metadata.recordingId, "media"),
        join(root, metadata.recordingId, "media", segment.streamId),
      ])
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
      for (const file of [
        join(root, metadata.recordingId, "metadata.json"),
        join(root, metadata.recordingId, "events.jsonl"),
        join(root, metadata.recordingId, "media", segment.streamId, `${segment.segmentId}.bin`),
        join(root, metadata.recordingId, "media", segment.streamId, `${segment.segmentId}.json`),
      ])
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    },
  );
  it("rejects traversal, absolute paths and cross-recording events", async () => {
    const store = new BrowserRecordingStore(root);
    for (const invalid of [
      "../escape",
      "/absolute",
      "..",
      "a/b",
      "a\\\\b",
      "",
      "CON",
      "nul",
      "Com1",
      "Lpt9",
    ])
      await expect(store.create({ ...metadata, recordingId: invalid })).rejects.toThrow();
    await store.create(metadata);
    await expect(
      store.appendEvent(metadata.recordingId, { ...event, recordingId: "other" }),
    ).rejects.toThrow();
    for (const invalid of [
      "../escape",
      "/absolute",
      "..",
      "a/b",
      "a\\\\b",
      "",
      "CON",
      "nul",
      "Com1",
      "Lpt9",
    ]) {
      await expect(
        store.writeMediaSegment(metadata.recordingId, { ...segment, streamId: invalid }),
      ).rejects.toThrow();
      await expect(
        store.writeMediaSegment(metadata.recordingId, { ...segment, segmentId: invalid }),
      ).rejects.toThrow();
      await expect(store.readMetadata(invalid)).rejects.toThrow();
    }
  });
  it("serializes concurrent metadata updates and exposes only complete JSON documents", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    let running = true;
    const reader = (async () => {
      for (;;) {
        if (!running) break;
        const text = await readFile(join(root, metadata.recordingId, "metadata.json"), "utf8");
        const parsed = JSON.parse(text);
        expect(parsed.recordingId).toBe(metadata.recordingId);
        expect(parsed.workspaceId).toBe(metadata.workspaceId);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    try {
      await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          store.updateMetadata(metadata.recordingId, { title: `version-${index}` }),
        ),
      );
    } finally {
      running = false;
      await reader;
    }
    expect((await store.readMetadata(metadata.recordingId)).title).toBe("version-29");
    expect(
      (await readdir(join(root, metadata.recordingId))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
  it("returns complete events and marks an interrupted trailing record without appending over it", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await store.appendEvent(metadata.recordingId, event);
    await appendFile(join(root, metadata.recordingId, "events.jsonl"), '{"partial":');
    expect(await store.readEvents(metadata.recordingId)).toEqual({
      events: [event],
      incompleteTail: true,
    });
    const page = await store.readEventsPage(metadata.recordingId, { cursor: 0, maxBytes: 4096 });
    expect(page.events).toEqual([event]);
    expect(page.nextCursor).not.toBeNull();
    const tail = await store.readEventsPage(metadata.recordingId, {
      cursor: page.nextCursor!,
      maxBytes: 4096,
    });
    expect(tail).toEqual({ events: [], nextCursor: null, incompleteTail: true });
    await expect(store.appendEvent(metadata.recordingId, event)).rejects.toThrow(/incomplete/i);
  });
  it("rejects oversized media without evicting earlier segments", async () => {
    const store = new BrowserRecordingStore(root, { maxMediaSegmentBytes: 4 });
    await store.create(metadata);
    await store.writeMediaSegment(metadata.recordingId, segment);
    await expect(
      store.writeMediaSegment(metadata.recordingId, {
        ...segment,
        segmentId: "large",
        bytes: new Uint8Array(5),
      }),
    ).rejects.toThrow(/limit/i);
    expect(
      (await store.readMediaSegment(metadata.recordingId, segment.streamId, segment.segmentId))
        .bytes,
    ).toEqual(segment.bytes);
  });
  it.skipIf(process.platform === "win32")(
    "does not follow a symlink substituted for the event file",
    async () => {
      const store = new BrowserRecordingStore(root);
      await store.create(metadata);
      const outside = join(root, "outside");
      await import("node:fs/promises").then((fs) => fs.writeFile(outside, "untouched"));
      await symlink(outside, join(root, metadata.recordingId, "events.jsonl"));
      await expect(store.appendEvent(metadata.recordingId, event)).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("untouched");
    },
  );
  it("rejects corrupted UTF-8 rather than silently replacing recorded bytes", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    const path = join(root, metadata.recordingId, "events.jsonl");
    await appendFile(
      path,
      Buffer.concat([Buffer.from('{"payload":"'), Buffer.from([0xff]), Buffer.from('"}\n')]),
    );
    await expect(store.readEvents(metadata.recordingId)).rejects.toThrow();
    await expect(
      store.readEventsPage(metadata.recordingId, { cursor: 0, maxBytes: 4096 }),
    ).rejects.toThrow();
  });
  it("serializes concurrent event appends without interleaving records", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        store.appendEvent(metadata.recordingId, { ...event, payload: { index } }),
      ),
    );
    const result = await store.readEvents(metadata.recordingId);
    expect(result.incompleteTail).toBe(false);
    expect(result.events.map((item) => (item.payload as { index: number }).index)).toEqual(
      Array.from({ length: 40 }, (_, index) => index),
    );
  });
  it("does not replace an existing recording on duplicate creation", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await store.appendEvent(metadata.recordingId, event);
    await expect(store.create({ ...metadata, workspaceId: "different" })).rejects.toThrow();
    expect(await store.readMetadata(metadata.recordingId)).toMatchObject(metadata);
    expect((await store.readEvents(metadata.recordingId)).events).toEqual([event]);
  });
  it("surfaces orphaned media after an interrupted publication", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await store.writeMediaSegment(metadata.recordingId, segment);
    const orphan = join(root, metadata.recordingId, "media", segment.streamId, "orphan.bin");
    await import("node:fs/promises").then((fs) => fs.writeFile(orphan, Buffer.from([1])));
    await expect(store.listMediaSegments(metadata.recordingId)).rejects.toThrow(
      /metadata is missing/i,
    );
    expect(await readFile(orphan)).toEqual(Buffer.from([1]));
  });
  it("bounds queued write bytes and recovers capacity after writes finish", async () => {
    const size = Buffer.byteLength(`${JSON.stringify(event)}\n`);
    const store = new BrowserRecordingStore(root, { maxQueuedBytes: size * 2 });
    await store.create(metadata);
    const results = await Promise.allSettled([
      store.appendEvent(metadata.recordingId, event),
      store.appendEvent(metadata.recordingId, event),
      store.appendEvent(metadata.recordingId, event),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((results[2] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/queue.*limit/i),
    });
    expect((await store.readEvents(metadata.recordingId)).events).toEqual([event, event]);
    await store.appendEvent(metadata.recordingId, event);
    expect((await store.readEvents(metadata.recordingId)).events).toHaveLength(3);
  });
  it("rejects non-JSON payloads instead of silently altering recorded values", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const hidden = Object.defineProperty({}, "private", { value: 1, enumerable: false });
    const hole: unknown[] = [];
    hole.length = 1;
    for (const payload of [
      { value: undefined },
      { value: NaN },
      { value: -0 },
      { value: 1n },
      { value: new Uint8Array([1]) },
      { value: new Date(0) },
      circular,
      hidden,
      hole,
    ]) {
      await expect(
        store.appendEvent(metadata.recordingId, { ...event, payload }),
      ).rejects.toThrow();
    }
    const payload = {
      nested: [null, true, 4.5, { text: "line\n雪", binary: { encoding: "base64", data: "AP8=" } }],
    };
    await store.appendEvent(metadata.recordingId, { ...event, payload });
    expect((await store.readEvents(metadata.recordingId)).events[0].payload).toEqual(payload);
  });
  it("serializes writes across store instances in the same desktop process", async () => {
    const first = new BrowserRecordingStore(root);
    const second = new BrowserRecordingStore(root);
    await first.create(metadata);
    await Promise.all([
      first.updateMetadata(metadata.recordingId, { status: "complete" }),
      second.updateMetadata(metadata.recordingId, { title: "Shared" }),
    ]);
    expect(await first.readMetadata(metadata.recordingId)).toMatchObject({
      status: "complete",
      title: "Shared",
    });
    await Promise.all([
      first.appendEvent(metadata.recordingId, event),
      second.appendEvent(metadata.recordingId, event),
    ]);
    expect((await first.readEvents(metadata.recordingId)).events).toEqual([event, event]);
  });
  it.skipIf(process.platform === "win32")(
    "rejects substituted metadata, recording and media directory symlinks and event hardlinks",
    async () => {
      const store = new BrowserRecordingStore(root);
      await store.create(metadata);
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "target"), "untouched");
      await symlink(outside, join(root, "linked-recording"));
      await expect(store.readMetadata("linked-recording")).rejects.toThrow();
      await unlink(join(root, metadata.recordingId, "metadata.json"));
      await symlink(join(outside, "target"), join(root, metadata.recordingId, "metadata.json"));
      await expect(store.readMetadata(metadata.recordingId)).rejects.toThrow();
      await symlink(outside, join(root, metadata.recordingId, "media"));
      await expect(store.writeMediaSegment(metadata.recordingId, segment)).rejects.toThrow();
      await link(join(outside, "target"), join(root, metadata.recordingId, "events.jsonl"));
      await expect(store.appendEvent(metadata.recordingId, event)).rejects.toThrow();
      expect(await readFile(join(outside, "target"), "utf8")).toBe("untouched");
    },
  );
  it("validates page bounds and returns a full record larger than the requested page", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await store.appendEvent(metadata.recordingId, event);
    for (const input of [
      { cursor: -1, maxBytes: 1 },
      { cursor: 0, maxBytes: 0 },
      { cursor: 0, maxBytes: 4 * 1024 * 1024 + 1 },
    ])
      await expect(store.readEventsPage(metadata.recordingId, input)).rejects.toThrow();
    const page = await store.readEventsPage(metadata.recordingId, { cursor: 0, maxBytes: 1 });
    expect(page.events).toEqual([event]);
    expect(page.nextCursor).toBeNull();
  });
  it("bounds queued operations and rejects oversized event records", async () => {
    const store = new BrowserRecordingStore(root, { maxQueuedOperations: 3 });
    await store.create(metadata);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => store.appendEvent(metadata.recordingId, event)),
    );
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
    expect((results[3] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/queue.*limit/i),
    });
    expect((await store.readEvents(metadata.recordingId)).events).toHaveLength(3);
    const limited = new BrowserRecordingStore(root, { maxEventBytes: 128 });
    await expect(limited.appendEvent(metadata.recordingId, event)).rejects.toThrow(/limit/i);
    expect((await store.readEvents(metadata.recordingId)).events).toHaveLength(3);
  });
  it("treats undefined optional metadata patch fields as unchanged", async () => {
    const store = new BrowserRecordingStore(root);
    await store.create(metadata);
    await store.updateMetadata(metadata.recordingId, { endedAt: 2000 });
    await store.updateMetadata(metadata.recordingId, { endedAt: undefined, title: "Updated" });
    expect(await store.readMetadata(metadata.recordingId)).toMatchObject({
      endedAt: 2000,
      title: "Updated",
    });
  });
  it.skipIf(process.platform === "win32")(
    "rejects a symlinked media stream or segment file",
    async () => {
      const store = new BrowserRecordingStore(root);
      await store.create(metadata);
      await store.writeMediaSegment(metadata.recordingId, segment);
      const outside = join(root, "outside-media");
      await mkdir(outside);
      await writeFile(join(outside, "target"), "untouched");
      const media = join(root, metadata.recordingId, "media");
      await symlink(outside, join(media, "unsafe-stream"));
      await expect(
        store.writeMediaSegment(metadata.recordingId, { ...segment, streamId: "unsafe-stream" }),
      ).rejects.toThrow();
      const bin = join(media, segment.streamId, `${segment.segmentId}.bin`);
      await unlink(bin);
      await symlink(join(outside, "target"), bin);
      await expect(
        store.readMediaSegment(metadata.recordingId, segment.streamId, segment.segmentId),
      ).rejects.toThrow();
      expect(await readFile(join(outside, "target"), "utf8")).toBe("untouched");
    },
  );
});
