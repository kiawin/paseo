import { describe, expect, test } from "vitest";

import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  WSOutboundMessageSchema,
} from "./messages.js";

const WATCH = {
  agentId: "agent-1",
  cwd: "/repo/worktree",
  forge: "github",
  prNumber: 42,
  prUrl: "https://github.com/acme/widgets/pull/42",
  state: { kind: "paused", reason: "attempt_limit", at: "2026-10-17T00:00:00.000Z" },
  headSha: "0123456789abcdef",
  attemptsForHead: 3,
  maxAttemptsPerHead: 3,
  updatedAt: "2026-10-17T00:00:00.000Z",
};

describe("PR watch messages", () => {
  test("gates the feature on server_info", () => {
    const parse = (features: Record<string, boolean>) =>
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "s", features })
        .features?.prAutoFix;
    expect(parse({})).toBeUndefined();
    expect(parse({ prAutoFix: true })).toBe(true);
  });

  test("accepts set and list requests through the inbound union", () => {
    const set = {
      type: "agent.pr_watch.set.request",
      agentId: "agent-1",
      enabled: true,
      requestId: "req-1",
    };
    const listAll = { type: "agent.pr_watch.list.request", requestId: "req-2" };
    expect(SessionInboundMessageSchema.parse(set)).toEqual(set);
    expect(SessionInboundMessageSchema.parse(listAll)).toEqual(listAll);
  });

  test("delivers set and list responses through the outbound union", () => {
    const setResponse = {
      type: "session",
      message: {
        type: "agent.pr_watch.set.response",
        payload: { watch: WATCH, success: true, error: null, requestId: "req-1" },
      },
    };
    const listResponse = {
      type: "session",
      message: {
        type: "agent.pr_watch.list.response",
        payload: { watches: [WATCH], success: true, error: null, requestId: "req-2" },
      },
    };
    expect(WSOutboundMessageSchema.parse(setResponse)).toEqual(setResponse);
    expect(WSOutboundMessageSchema.parse(listResponse)).toEqual(listResponse);
  });

  test("keeps state reasons open so a newer daemon can add one", () => {
    const response = {
      type: "session",
      message: {
        type: "agent.pr_watch.list.response",
        payload: {
          watches: [
            { ...WATCH, state: { kind: "stopped", reason: "some_future_reason", at: "now" } },
          ],
          success: true,
          error: null,
          requestId: "req-3",
        },
      },
    };
    expect(WSOutboundMessageSchema.parse(response)).toEqual(response);
  });
});

const SETTINGS = {
  autoReview: true,
  reviewProvider: "codex/gpt-5",
  postReviews: false,
  autoFixAgentPullRequests: true,
};

const REVIEW = {
  projectId: "prj_1",
  prNumber: 7,
  prUrl: "https://github.com/acme/widgets/pull/7",
  agentId: "agent-2",
  workspaceId: "ws-2",
  reviewedHeadSha: "abc",
  state: "active",
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};

describe("PR review and project automation messages", () => {
  test("accepts settings, list and review requests through the inbound union", () => {
    const requests = [
      {
        type: "project.pr_automation.set.request",
        projectId: "prj_1",
        settings: SETTINGS,
        requestId: "req-1",
      },
      { type: "project.review_requests.list.request", requestId: "req-2" },
      {
        type: "project.review_requests.review.request",
        projectId: "prj_1",
        prNumber: 7,
        provider: "claude",
        requestId: "req-3",
      },
    ];
    for (const request of requests) {
      expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    }
  });

  test("delivers their responses through the outbound union", () => {
    const messages = [
      {
        type: "project.pr_automation.set.response",
        payload: {
          requestId: "req-1",
          projectId: "prj_1",
          accepted: true,
          settings: SETTINGS,
          error: null,
        },
      },
      {
        type: "project.review_requests.list.response",
        payload: {
          requestId: "req-2",
          reviewRequests: [
            {
              projectId: "prj_1",
              number: 7,
              title: "Add retry",
              url: REVIEW.prUrl,
              author: "teammate",
              baseRefName: "main",
              headRefName: "feature/retry",
              headSha: "abc",
              isDraft: false,
              isCrossRepository: false,
              updatedAt: "2026-10-17T00:00:00.000Z",
              review: REVIEW,
            },
          ],
          errors: [{ projectId: "prj_2", message: "gh not authenticated" }],
          success: true,
          error: null,
        },
      },
      {
        type: "project.review_requests.review.response",
        payload: { requestId: "req-3", review: REVIEW, success: true, error: null },
      },
    ];
    for (const message of messages) {
      const envelope = { type: "session", message };
      expect(WSOutboundMessageSchema.parse(envelope)).toEqual(envelope);
    }
  });
});
