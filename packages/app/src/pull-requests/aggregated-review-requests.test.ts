import type { ReviewRequestPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  fetchAggregatedReviewRequests,
  type HostReviewRequests,
  type ReviewRequestRuntime,
} from "./aggregated-review-requests";

function makeRequest(number: number): ReviewRequestPayload {
  return {
    projectId: "proj",
    number,
    title: "Add the thing",
    url: `https://github.com/getpaseo/paseo/pull/${number}`,
    author: "octocat",
    baseRefName: "main",
    headRefName: "feature",
    headSha: null,
    isDraft: false,
    isCrossRepository: false,
    updatedAt: "2026-10-17T00:00:00.000Z",
    review: null,
  };
}

function makeRuntime(input: {
  statuses: Record<string, string>;
  results: Record<string, HostReviewRequests | Error>;
}): ReviewRequestRuntime {
  return {
    getSnapshot: (serverId) => {
      const connectionStatus = input.statuses[serverId];
      return connectionStatus ? { connectionStatus } : null;
    },
    getClient: (serverId) => {
      const result = input.results[serverId];
      if (!result) return null;
      return {
        listReviewRequests: async () => {
          if (result instanceof Error) throw result;
          return result;
        },
      };
    },
  };
}

describe("fetchAggregatedReviewRequests", () => {
  it("keeps each host's requests and per-project errors", async () => {
    const answer: HostReviewRequests = {
      reviewRequests: [makeRequest(4)],
      errors: [{ projectId: "other", message: "gh is not logged in" }],
    };
    const result = await fetchAggregatedReviewRequests({
      hosts: [{ serverId: "a", serverName: "Alpha" }],
      runtime: makeRuntime({ statuses: { a: "online" }, results: { a: answer } }),
    });

    expect(result.byServerId.get("a")).toEqual(answer);
    expect(result.hostErrors).toEqual([]);
  });

  it("reports a failing host without dropping the others", async () => {
    const result = await fetchAggregatedReviewRequests({
      hosts: [
        { serverId: "a", serverName: "Alpha" },
        { serverId: "b", serverName: "Beta" },
      ],
      runtime: makeRuntime({
        statuses: { a: "online", b: "online" },
        results: {
          a: { reviewRequests: [makeRequest(1)], errors: [] },
          b: new Error("boom"),
        },
      }),
    });

    expect(result.byServerId.has("a")).toBe(true);
    expect(result.byServerId.has("b")).toBe(false);
    expect(result.hostErrors).toEqual([{ serverId: "b", serverName: "Beta", message: "boom" }]);
  });

  it("skips hosts that are not online", async () => {
    const result = await fetchAggregatedReviewRequests({
      hosts: [{ serverId: "a", serverName: "Alpha" }],
      runtime: makeRuntime({
        statuses: { a: "connecting" },
        results: { a: { reviewRequests: [makeRequest(1)], errors: [] } },
      }),
    });

    expect(result.byServerId.size).toBe(0);
    expect(result.hostErrors).toEqual([]);
  });
});
