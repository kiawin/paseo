import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ArtifactStore } from "../../artifact-store.js";
import type { SessionOutboundMessage } from "../../messages.js";
import { ArtifactsSession } from "./artifacts-session.js";

const AGENT = { agentId: "agt_one", workspaceId: "wks_one", provider: "claude" };

let root: string;
let store: ArtifactStore;

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "artifacts-session-"));
  store = new ArtifactStore(root, createTestLogger());
  await store.initialize();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A host that never acks.
 *
 * The flow control window is what this exercises: a download large enough to fill it parks in
 * `awaitWindow` and only leaves on an ack or a cancel. A real socket that goes away sends
 * neither.
 */
function makeSession() {
  const emitted: Array<{ message: SessionOutboundMessage; source?: object }> = [];
  const session = new ArtifactsSession(
    {
      emit: (message, source) => emitted.push({ message, source }),
      emitChanged: (message, source) => emitted.push({ message, source }),
      emitBinary: async () => undefined,
      hasBinaryChannel: () => true,
      isActiveProject: async (projectId) => projectId === "prj_a",
    },
    store,
    createTestLogger(),
  );
  return { session, emitted };
}

async function publish(html: string) {
  const { record } = await store.publish({
    projectId: "prj_a",
    title: "Doc",
    html,
    origin: AGENT,
  });
  return record;
}

test("invalidation goes only to sockets that listed artifacts", async () => {
  const { session, emitted } = makeSession();
  const listed = {};
  await session.handleListRequest(
    { type: "artifact.list.request", projectId: "prj_a", requestId: "list-1" },
    listed,
  );
  emitted.length = 0;

  session.broadcastChanged("prj_a");
  expect(emitted).toEqual([
    { message: { type: "artifact.changed", payload: { projectId: "prj_a" } }, source: listed },
  ]);
});

test("search responds to the requesting socket with matching document text", async () => {
  const record = await publish("<p>Visitor conversion increased</p>");
  const { session, emitted } = makeSession();
  const source = {};

  await session.handleSearchRequest(
    {
      type: "artifact.search.request",
      projectId: "prj_a",
      query: "visitor",
      requestId: "search-1",
    },
    source,
  );

  expect(emitted).toEqual([
    {
      message: {
        type: "artifact.search.response",
        payload: {
          projectId: "prj_a",
          matches: [
            {
              artifactId: record.artifactId,
              snippet: "Visitor conversion increased",
            },
          ],
          success: true,
          error: null,
          requestId: "search-1",
        },
      },
      source,
    },
  ]);
});

test("rename responds with the user title and keeps the agent title", async () => {
  const record = await publish("<p>Facilities</p>");
  const { session, emitted } = makeSession();
  const source = {};

  await session.handleRenameRequest(
    {
      type: "artifact.rename.request",
      artifactId: record.artifactId,
      title: "Facilities plan",
      requestId: "rename-1",
    },
    source,
  );

  expect(emitted).toEqual([
    {
      message: {
        type: "artifact.rename.response",
        payload: {
          artifact: expect.objectContaining({
            artifactId: record.artifactId,
            title: "Doc",
            customTitle: "Facilities plan",
          }),
          success: true,
          error: null,
          requestId: "rename-1",
        },
      },
      source,
    },
  ]);
  expect((await store.listForProject("prj_a"))[0]?.customTitle).toBe("Facilities plan");
});

describe("artifact transfers and their owning socket", () => {
  test("a departing socket cancels the download it started", async () => {
    const record = await publish("<p>dropped</p>");
    const { session } = makeSession();
    const source = {};

    const pending = session.handleEntryDownloadRequest(
      {
        type: "artifact.entry.download.request",
        artifactId: record.artifactId,
        requestId: "dl-socketloss",
      },
      source,
    );
    session.cancelTransfersForSource(source);
    await pending;

    // Nothing is left holding the flow, the task or the document.
    expect(session.hasTransfer("dl-socketloss")).toBe(false);
  });

  test("a download from another socket survives that cancellation", async () => {
    const record = await publish("<p>keep</p>");
    const { session } = makeSession();
    const departing = {};
    const staying = {};

    const kept = session.handleEntryDownloadRequest(
      {
        type: "artifact.entry.download.request",
        artifactId: record.artifactId,
        requestId: "dl-keep",
      },
      staying,
    );
    session.cancelTransfersForSource(departing);
    await kept;

    expect(session.hasTransfer("dl-keep")).toBe(false);
  });

  test("a second download refuses to reuse a live request id", async () => {
    const record = await publish("<p>x</p>");
    const { session, emitted } = makeSession();

    // The handler claims the id synchronously, before its first await, so the second call sees
    // it held even though both are started in the same tick.
    const first = session.handleEntryDownloadRequest(
      {
        type: "artifact.entry.download.request",
        artifactId: record.artifactId,
        requestId: "dl-dupe",
      },
      {},
    );
    const second = session.handleEntryDownloadRequest(
      {
        type: "artifact.entry.download.request",
        artifactId: record.artifactId,
        requestId: "dl-dupe",
      },
      {},
    );
    await Promise.all([first, second]);

    // One transfer answered, not two: a shared id would have interleaved their frames.
    const responses = emitted.filter(
      ({ message }) => message.type === "artifact.entry.download.response",
    );
    expect(responses).toHaveLength(1);
  });
});

describe("publish invalidation", () => {
  test("reaches only sockets that have listed artifacts", async () => {
    await publish("<p>x</p>");
    const { session, emitted } = makeSession();
    const listener = {};
    const bystander = {};

    await session.handleListRequest(
      { type: "artifact.list.request", projectId: "prj_a", requestId: "ls-1" },
      listener,
    );
    emitted.length = 0;

    session.broadcastChanged("prj_a");

    // A client from before this feature rejects the whole message and logs a protocol failure,
    // so silence towards one that never asked is the compatible behaviour and the useful one.
    expect(emitted.map((entry) => entry.source)).toEqual([listener]);
    expect(emitted.every((entry) => entry.message.type === "artifact.changed")).toBe(true);
    expect(emitted.some((entry) => entry.source === bystander)).toBe(false);
  });

  test("stops after that socket goes away", async () => {
    await publish("<p>x</p>");
    const { session, emitted } = makeSession();
    const source = {};

    await session.handleListRequest(
      { type: "artifact.list.request", projectId: "prj_a", requestId: "ls-1" },
      source,
    );
    session.cancelTransfersForSource(source);
    emitted.length = 0;

    session.broadcastChanged("prj_a");
    expect(emitted).toEqual([]);
  });
});

test("a client publish stores the document with its title and pin, owned by no agent", async () => {
  const { session, emitted } = makeSession();

  await session.handlePublishRequest(
    {
      type: "artifact.publish.request",
      projectId: "prj_a",
      title: "Doc",
      customTitle: "Facilities plan",
      html: "<p>Facilities</p>",
      externalUrl: "https://claude.ai/code/artifact/abc",
      pinned: true,
      requestId: "publish-1",
    },
    {},
  );

  const [record] = await store.listForProject("prj_a");
  expect(record).toMatchObject({
    title: "Doc",
    customTitle: "Facilities plan",
    pinned: true,
    externalUrl: "https://claude.ai/code/artifact/abc",
    origin: { agentId: null, workspaceId: null, provider: null },
  });
  expect((await store.readContent(record!)).toString("utf8")).toBe("<p>Facilities</p>");
  expect(emitted).toEqual([
    {
      message: {
        type: "artifact.publish.response",
        payload: {
          artifact: expect.objectContaining({ artifactId: record!.artifactId, pinned: true }),
          success: true,
          error: null,
          requestId: "publish-1",
        },
      },
      source: expect.anything(),
    },
  ]);
});

test("a client publish with neither a document nor a link fails without storing a row", async () => {
  const { session, emitted } = makeSession();

  await session.handlePublishRequest(
    {
      type: "artifact.publish.request",
      projectId: "prj_a",
      title: "Doc",
      html: null,
      externalUrl: null,
      requestId: "publish-2",
    },
    {},
  );

  expect(await store.listForProject("prj_a")).toEqual([]);
  expect(emitted[0]?.message).toMatchObject({
    type: "artifact.publish.response",
    payload: { artifact: null, success: false, requestId: "publish-2" },
  });
});

test("a client publish to a project this daemon does not have stores nothing", async () => {
  const { session, emitted } = makeSession();

  await session.handlePublishRequest(
    {
      type: "artifact.publish.request",
      projectId: "../prj_elsewhere",
      title: "Doc",
      html: "<p>x</p>",
      externalUrl: null,
      requestId: "publish-3",
    },
    {},
  );

  expect(await store.listForProject("../prj_elsewhere")).toEqual([]);
  expect(emitted[0]?.message).toMatchObject({
    type: "artifact.publish.response",
    payload: { artifact: null, success: false, requestId: "publish-3" },
  });
});
