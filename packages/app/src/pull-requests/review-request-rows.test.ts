import { describe, expect, it } from "vitest";
import type { PrReviewPayload, ReviewRequestPayload } from "@getpaseo/protocol/messages";
import {
  buildReviewRequestMeta,
  collectReviewRequestRows,
  describeReviewRequestBadges,
  describeReviewRequestErrors,
  resolveReviewAction,
  type ReviewRequestSourceHost,
} from "./review-request-rows";

function review(overrides: Partial<PrReviewPayload> = {}): PrReviewPayload {
  return {
    projectId: "proj",
    prNumber: 7,
    prUrl: "https://github.com/getpaseo/paseo/pull/7",
    agentId: "agent-1",
    workspaceId: "ws-review",
    reviewedHeadSha: null,
    state: "active",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
}

function request(overrides: Partial<ReviewRequestPayload> = {}): ReviewRequestPayload {
  return {
    projectId: "proj",
    number: 7,
    title: "Add the thing",
    url: "https://github.com/getpaseo/paseo/pull/7",
    author: "octocat",
    baseRefName: "main",
    headRefName: "feature",
    headSha: "abc",
    isDraft: false,
    isCrossRepository: false,
    updatedAt: "2026-10-17T00:00:00.000Z",
    review: null,
    ...overrides,
  };
}

function host(overrides: Partial<ReviewRequestSourceHost> = {}): ReviewRequestSourceHost {
  return {
    serverId: "srv",
    serverName: "Laptop",
    reviewRequests: [],
    errors: [],
    projectNames: new Map([["proj", "paseo"]]),
    ...overrides,
  };
}

describe("resolveReviewAction", () => {
  it("opens an active review that has a workspace", () => {
    expect(resolveReviewAction(review())).toEqual({ kind: "open", workspaceId: "ws-review" });
  });

  it("starts a review when there is none", () => {
    expect(resolveReviewAction(null)).toEqual({ kind: "review" });
  });

  it("starts over when the review was archived", () => {
    expect(resolveReviewAction(review({ state: "archived" }))).toEqual({ kind: "review" });
  });

  it("starts over when the review has no workspace", () => {
    expect(resolveReviewAction(review({ workspaceId: null }))).toEqual({ kind: "review" });
  });
});

describe("collectReviewRequestRows", () => {
  it("resolves the project name and the action for each request", () => {
    const rows = collectReviewRequestRows([
      host({ reviewRequests: [request({ review: review() })] }),
    ]);

    expect(rows).toEqual([
      {
        key: "srv:proj:7",
        serverId: "srv",
        serverName: "Laptop",
        projectId: "proj",
        projectName: "paseo",
        number: 7,
        title: "Add the thing",
        url: "https://github.com/getpaseo/paseo/pull/7",
        author: "octocat",
        isDraft: false,
        isFork: false,
        updatedAt: "2026-10-17T00:00:00.000Z",
        action: { kind: "open", workspaceId: "ws-review" },
      },
    ]);
  });

  it("leaves the project name empty when the host has not sent the project", () => {
    const [row] = collectReviewRequestRows([
      host({ reviewRequests: [request({ projectId: "other" })] }),
    ]);
    expect(row?.projectName).toBeNull();
  });

  it("orders requests across hosts by most recent update", () => {
    const rows = collectReviewRequestRows([
      host({
        reviewRequests: [
          request({ number: 1, updatedAt: "2026-10-15T00:00:00.000Z" }),
          request({ number: 2, updatedAt: "2026-10-17T00:00:00.000Z" }),
        ],
      }),
      host({
        serverId: "srv-2",
        serverName: "Desktop",
        reviewRequests: [request({ number: 3, updatedAt: "2026-10-16T00:00:00.000Z" })],
      }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["srv:proj:2", "srv-2:proj:3", "srv:proj:1"]);
  });
});

describe("describeReviewRequestBadges", () => {
  it("marks fork and draft pull requests", () => {
    expect(describeReviewRequestBadges({ isFork: true, isDraft: true })).toEqual([
      { label: "Fork", variant: "muted" },
      { label: "Draft", variant: "muted" },
    ]);
  });

  it("adds nothing for a same-repo ready pull request", () => {
    expect(describeReviewRequestBadges({ isFork: false, isDraft: false })).toEqual([]);
  });
});

describe("buildReviewRequestMeta", () => {
  const [row] = collectReviewRequestRows([host({ reviewRequests: [request()] })]);

  it("joins number, author, and project", () => {
    expect(row && buildReviewRequestMeta(row, false)).toBe("#7 · octocat · paseo");
  });

  it("appends the host when several are connected", () => {
    expect(row && buildReviewRequestMeta(row, true)).toBe("#7 · octocat · paseo · Laptop");
  });

  it("skips an unknown author and project", () => {
    const [bare] = collectReviewRequestRows([
      host({ reviewRequests: [request({ author: null, projectId: "other" })] }),
    ]);
    expect(bare && buildReviewRequestMeta(bare, false)).toBe("#7");
  });
});

describe("describeReviewRequestErrors", () => {
  it("collapses projects that failed for the same reason into one line", () => {
    const lines = describeReviewRequestErrors({
      hosts: [
        host({
          projectNames: new Map([
            ["a", "alpha"],
            ["b", "beta"],
          ]),
          errors: [
            { projectId: "a", message: "gh is not logged in" },
            { projectId: "b", message: "gh is not logged in" },
            { projectId: "c", message: "Not found" },
          ],
        }),
      ],
      hostErrors: [],
    });
    expect(lines).toEqual([
      { key: "srv:gh is not logged in", text: "Laptop · alpha, beta: gh is not logged in" },
      { key: "srv:Not found", text: "Laptop · c: Not found" },
    ]);
  });

  it("reports a host whose list failed outright", () => {
    expect(
      describeReviewRequestErrors({
        hosts: [],
        hostErrors: [{ serverId: "srv", serverName: "Laptop" }],
      }),
    ).toEqual([{ key: "srv", text: "Laptop: Could not load review requests" }]);
  });
});
