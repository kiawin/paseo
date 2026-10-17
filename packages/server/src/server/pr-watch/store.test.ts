import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createInitialPrWatchCiState, PrWatchStore, type PrWatchRecord } from "./store.js";

function watchRecord(overrides: Partial<PrWatchRecord> = {}): PrWatchRecord {
  return {
    agentId: "agent-1",
    cwd: "/repo/worktree",
    forge: "github",
    headRef: "feature/retry",
    prNumber: 42,
    prUrl: "https://github.com/acme/widgets/pull/42",
    state: { kind: "active" },
    ci: createInitialPrWatchCiState(),
    review: { since: "2026-10-17T00:00:00.000Z", lastUpdatedAt: null, seenCommentIds: [] },
    conflict: { notifiedHeadSha: null },
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("PrWatchStore", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-pr-watch-store-"));
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("keeps watches across a daemon restart", async () => {
    const store = new PrWatchStore(paseoHome, createTestLogger());
    await store.upsert(watchRecord());
    await store.update("agent-1", (record) => ({
      ...record,
      ci: { ...record.ci, headSha: "abc123", seenFailureKeys: ["check-run:7"], attemptsForHead: 1 },
    }));

    const reopened = new PrWatchStore(paseoHome, createTestLogger());

    expect(await reopened.get("agent-1")).toEqual(
      watchRecord({
        ci: {
          headSha: "abc123",
          seenFailureKeys: ["check-run:7"],
          attemptsForHead: 1,
          consecutiveFailedHeads: 0,
        },
      }),
    );
  });

  test("lists only active watches", async () => {
    const store = new PrWatchStore(paseoHome, createTestLogger());
    await store.upsert(watchRecord({ agentId: "active-agent" }));
    await store.upsert(
      watchRecord({
        agentId: "paused-agent",
        state: { kind: "paused", reason: "attempt_limit", at: "2026-10-17T01:00:00.000Z" },
      }),
    );
    await store.upsert(
      watchRecord({
        agentId: "stopped-agent",
        state: { kind: "stopped", reason: "merged", at: "2026-10-17T02:00:00.000Z" },
      }),
    );

    expect((await store.listActive()).map((record) => record.agentId)).toEqual(["active-agent"]);
  });

  test("rejects a state with an unknown reason", async () => {
    const store = new PrWatchStore(paseoHome, createTestLogger());

    await expect(
      store.upsert(
        watchRecord({
          state: {
            kind: "paused",
            reason: "bored",
            at: "now",
          } as unknown as PrWatchRecord["state"],
        }),
      ),
    ).rejects.toThrow();
  });
});
