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

function url(number: number): string {
  return `https://github.com/getpaseo/paseo/pull/${number}`;
}

describe("collectReviewRequestRows", () => {
  it("resolves the project name and the active review for each request", () => {
    const rows = collectReviewRequestRows([
      host({ reviewRequests: [request({ review: review() })] }),
    ]);

    const target = {
      serverId: "srv",
      serverName: "Laptop",
      projectId: "proj",
      projectName: "paseo",
    };
    expect(rows).toEqual([
      {
        key: url(7),
        number: 7,
        title: "Add the thing",
        url: url(7),
        author: "octocat",
        isDraft: false,
        isFork: false,
        updatedAt: "2026-10-17T00:00:00.000Z",
        targets: [target],
        activeReview: { target, workspaceId: "ws-review" },
      },
    ]);
  });

  it("leaves the project name empty when the host has not sent the project", () => {
    const [row] = collectReviewRequestRows([
      host({ reviewRequests: [request({ projectId: "other" })] }),
    ]);
    expect(row?.targets[0]?.projectName).toBeNull();
    expect(row?.activeReview).toBeNull();
  });

  it("orders requests across hosts by most recent update", () => {
    const rows = collectReviewRequestRows([
      host({
        reviewRequests: [
          request({ number: 1, url: url(1), updatedAt: "2026-10-15T00:00:00.000Z" }),
          request({ number: 2, url: url(2), updatedAt: "2026-10-17T00:00:00.000Z" }),
        ],
      }),
      host({
        serverId: "srv-2",
        serverName: "Desktop",
        reviewRequests: [
          request({ number: 3, url: url(3), updatedAt: "2026-10-16T00:00:00.000Z" }),
        ],
      }),
    ]);
    expect(rows.map((row) => row.key)).toEqual([url(2), url(3), url(1)]);
  });

  it("folds the same pull request from several hosts into one row with every host", () => {
    const rows = collectReviewRequestRows([
      host({ serverId: "srv-b", serverName: "Laptop", reviewRequests: [request()] }),
      host({
        serverId: "srv-a",
        serverName: "Desktop",
        projectNames: new Map([["proj-a", "paseo-desk"]]),
        reviewRequests: [request({ projectId: "proj-a" })],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targets).toEqual([
      { serverId: "srv-a", serverName: "Desktop", projectId: "proj-a", projectName: "paseo-desk" },
      { serverId: "srv-b", serverName: "Laptop", projectId: "proj", projectName: "paseo" },
    ]);
    expect(rows[0]?.activeReview).toBeNull();
  });

  it("opens the newest active review when several hosts are reviewing", () => {
    const [row] = collectReviewRequestRows([
      host({
        reviewRequests: [
          request({
            review: review({ workspaceId: "ws-old", updatedAt: "2026-10-16T00:00:00.000Z" }),
          }),
        ],
      }),
      host({
        serverId: "srv-2",
        serverName: "Desktop",
        reviewRequests: [
          request({
            review: review({ workspaceId: "ws-new", updatedAt: "2026-10-17T00:00:00.000Z" }),
          }),
        ],
      }),
      host({
        serverId: "srv-3",
        serverName: "Server",
        reviewRequests: [
          request({ review: review({ state: "archived", updatedAt: "2026-10-18T00:00:00.000Z" }) }),
        ],
      }),
    ]);
    expect(row?.activeReview).toEqual({
      target: { serverId: "srv-2", serverName: "Desktop", projectId: "proj", projectName: "paseo" },
      workspaceId: "ws-new",
    });
  });

  it("takes the title and draft state from the most recently updated host", () => {
    const [row] = collectReviewRequestRows([
      host({ reviewRequests: [request({ title: "Old", isDraft: true })] }),
      host({
        serverId: "srv-2",
        reviewRequests: [
          request({ title: "New", isDraft: false, updatedAt: "2026-10-18T00:00:00.000Z" }),
        ],
      }),
    ]);
    expect(row).toMatchObject({
      title: "New",
      isDraft: false,
      updatedAt: "2026-10-18T00:00:00.000Z",
    });
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

  it("lists every host that can review until one is reviewing", () => {
    const [shared] = collectReviewRequestRows([
      host({ reviewRequests: [request()] }),
      host({ serverId: "srv-2", serverName: "Desktop", reviewRequests: [request()] }),
    ]);
    expect(shared && buildReviewRequestMeta(shared, true)).toBe(
      "#7 · octocat · paseo · Desktop, Laptop",
    );

    const [reviewing] = collectReviewRequestRows([
      host({ reviewRequests: [request()] }),
      host({
        serverId: "srv-2",
        serverName: "Desktop",
        reviewRequests: [request({ review: review() })],
      }),
    ]);
    expect(reviewing && buildReviewRequestMeta(reviewing, true)).toBe(
      "#7 · octocat · paseo · Desktop",
    );
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
