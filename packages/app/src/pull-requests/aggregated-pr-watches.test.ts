import type { PrWatchPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { fetchAggregatedPrWatches, type PrWatchRuntime } from "./aggregated-pr-watches";

function makeWatch(agentId: string): PrWatchPayload {
  return {
    agentId,
    cwd: "/repo",
    forge: "github",
    prNumber: 4,
    prUrl: "https://github.com/getpaseo/paseo/pull/4",
    state: { kind: "active" },
    headSha: null,
    attemptsForHead: 0,
    maxAttemptsPerHead: 3,
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
}

function makeRuntime(input: {
  statuses: Record<string, string>;
  watches: Record<string, PrWatchPayload[] | Error>;
}): PrWatchRuntime {
  return {
    getSnapshot: (serverId) => {
      const connectionStatus = input.statuses[serverId];
      return connectionStatus ? { connectionStatus } : null;
    },
    getClient: (serverId) => {
      const result = input.watches[serverId];
      if (!result) return null;
      return {
        listAgentPrWatches: async () => {
          if (result instanceof Error) throw result;
          return result;
        },
      };
    },
  };
}

describe("fetchAggregatedPrWatches", () => {
  it("keys watches by agent per online host and reports failing hosts", async () => {
    const result = await fetchAggregatedPrWatches({
      hosts: [
        { serverId: "a", serverName: "Laptop" },
        { serverId: "b", serverName: "Desktop" },
        { serverId: "c", serverName: "Offline" },
      ],
      runtime: makeRuntime({
        statuses: { a: "online", b: "online", c: "offline" },
        watches: {
          a: [makeWatch("agent-1"), makeWatch("agent-2")],
          b: new Error("Daemon refused"),
          c: [makeWatch("agent-3")],
        },
      }),
    });

    expect([...result.byServerId.keys()]).toEqual(["a"]);
    expect([...(result.byServerId.get("a")?.keys() ?? [])]).toEqual(["agent-1", "agent-2"]);
    expect(result.hostErrors).toEqual([
      { serverId: "b", serverName: "Desktop", message: "Daemon refused" },
    ]);
  });
});
