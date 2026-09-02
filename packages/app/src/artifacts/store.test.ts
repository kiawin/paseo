import { beforeEach, describe, expect, test } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useArtifactsStore } from "./store";

const SERVER = "srv_one";
const ARTIFACT = "art_one";
const V1 = "a".repeat(64);
const V2 = "b".repeat(64);

/**
 * A client whose downloads finish only when the test says so.
 *
 * The race under test needs two loads in flight at once, so completion order has to be the
 * test's choice rather than the scheduler's.
 */
function makeClient() {
  const pending = new Map<string, (html: string) => void>();
  const client = {
    downloadArtifact: ({ sink }: { sink: { onChunk(chunk: Uint8Array): void } }) =>
      new Promise((resolve) => {
        pending.set(String(pending.size), (html: string) => {
          sink.onChunk(new TextEncoder().encode(html));
          resolve({ artifactId: ARTIFACT, title: "Doc", mimeType: "text/html", size: html.length });
        });
      }),
  } as unknown as DaemonClient;
  const finish = (index: number, html: string) => pending.get(String(index))?.(html);
  return { client, finish };
}

function contentState() {
  return useArtifactsStore.getState().contents[`${SERVER}:${ARTIFACT}`];
}

describe("artifact content loading", () => {
  beforeEach(() => {
    useArtifactsStore.setState({ contents: {}, lists: {} });
  });

  test("a republish mid-load supersedes the version being fetched", async () => {
    const { client, finish } = makeClient();
    const load = (contentSha256: string) =>
      useArtifactsStore
        .getState()
        .loadContent({ client, serverId: SERVER, artifactId: ARTIFACT, contentSha256 });

    const first = load(V1);
    // The republish arrives while v1 is still streaming. Before, this returned early on
    // `isLoading` and the pane stayed on v1 for good.
    const second = load(V2);

    finish(1, "<p>v2</p>");
    await second;
    expect(contentState()?.html).toBe("<p>v2</p>");
    expect(contentState()?.contentSha256).toBe(V2);

    // v1 lands late. It must not overwrite the version that superseded it.
    finish(0, "<p>v1</p>");
    await first;
    expect(contentState()?.html).toBe("<p>v2</p>");
    expect(contentState()?.contentSha256).toBe(V2);
  });

  test("a second request for the version already loading does not start another", async () => {
    const { client, finish } = makeClient();
    const load = () =>
      useArtifactsStore
        .getState()
        .loadContent({ client, serverId: SERVER, artifactId: ARTIFACT, contentSha256: V1 });

    const first = load();
    await load();

    finish(0, "<p>v1</p>");
    await first;
    expect(contentState()?.html).toBe("<p>v1</p>");
    // One download, not two: a duplicate would have registered a second pending entry.
    expect(finish(1, "<p>never</p>")).toBeUndefined();
  });
});
