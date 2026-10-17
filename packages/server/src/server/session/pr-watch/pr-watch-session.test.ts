import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { PrWatchService } from "../../pr-watch/service.js";
import type { PrWatchRecord } from "../../pr-watch/store.js";
import { PrWatchSession } from "./pr-watch-session.js";

const RECORD: PrWatchRecord = {
  agentId: "agent-1",
  cwd: "/repo/worktree",
  forge: "github",
  headRef: "feature/retry",
  prNumber: 42,
  prUrl: "https://github.com/acme/widgets/pull/42",
  state: { kind: "active" },
  ci: {
    headSha: "head-1",
    seenFailureKeys: ["check-run:7"],
    attemptsForHead: 1,
    consecutiveFailedHeads: 1,
  },
  review: { since: "2026-10-17T00:00:00.000Z", lastUpdatedAt: null, seenCommentIds: [] },
  conflict: { notifiedHeadSha: null },
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:01:00.000Z",
};

function sessionWith(service: Partial<PrWatchService> | null) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new PrWatchSession(
    { emit: (message) => emitted.push(message) },
    service as PrWatchService | null,
    createTestLogger(),
  );
  return { session, emitted };
}

describe("PrWatchSession", () => {
  test("returns the watch it turned on", async () => {
    const { session, emitted } = sessionWith({ setWatch: async () => RECORD });

    await session.handleSetRequest({
      type: "agent.pr_watch.set.request",
      agentId: "agent-1",
      enabled: true,
      requestId: "req-1",
    });

    expect(emitted).toEqual([
      {
        type: "agent.pr_watch.set.response",
        payload: {
          watch: {
            agentId: "agent-1",
            cwd: "/repo/worktree",
            forge: "github",
            prNumber: 42,
            prUrl: "https://github.com/acme/widgets/pull/42",
            state: { kind: "active" },
            headSha: "head-1",
            attemptsForHead: 1,
            maxAttemptsPerHead: 3,
            updatedAt: "2026-10-17T00:01:00.000Z",
          },
          success: true,
          error: null,
          requestId: "req-1",
        },
      },
    ]);
  });

  test("lists only the requested agent's watch", async () => {
    const { session, emitted } = sessionWith({
      list: async () => [RECORD, { ...RECORD, agentId: "agent-2" }],
    });

    await session.handleListRequest({
      type: "agent.pr_watch.list.request",
      agentId: "agent-2",
      requestId: "req-2",
    });

    expect(emitted).toMatchObject([
      { type: "agent.pr_watch.list.response", payload: { watches: [{ agentId: "agent-2" }] } },
    ]);
  });

  test("reports a daemon without PR auto-fix as a failed request", async () => {
    const { session, emitted } = sessionWith(null);

    await session.handleListRequest({ type: "agent.pr_watch.list.request", requestId: "req-3" });

    expect(emitted).toEqual([
      {
        type: "agent.pr_watch.list.response",
        payload: {
          watches: [],
          success: false,
          error: "PR auto-fix is not available on this daemon",
          requestId: "req-3",
        },
      },
    ]);
  });
});
