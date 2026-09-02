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
  const emitted: SessionOutboundMessage[] = [];
  const session = new ArtifactsSession(
    {
      emit: (msg) => emitted.push(msg),
      emitBinary: async () => undefined,
      hasBinaryChannel: () => true,
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
      (message) => message.type === "artifact.entry.download.response",
    );
    expect(responses).toHaveLength(1);
  });
});
