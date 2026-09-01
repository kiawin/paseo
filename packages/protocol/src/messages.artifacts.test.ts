import { describe, expect, test } from "vitest";

import {
  ArtifactChangedMessageSchema,
  ArtifactDeleteRequestSchema,
  ArtifactDeleteResponseSchema,
  ArtifactEntryDownloadRequestSchema,
  ArtifactEntryDownloadResponseSchema,
  ArtifactListRequestSchema,
  ArtifactListResponseSchema,
  ArtifactPinSetRequestSchema,
  ArtifactPinSetResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  WSOutboundMessageSchema,
} from "./messages.js";

const RECORD = {
  artifactId: "art_0123456789abcdef",
  projectId: "prj_0123456789abcdef",
  title: "Q3 revenue dashboard",
  mimeType: "text/html",
  size: 2048,
  contentSha256: "a".repeat(64),
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  pinned: false,
  externalUrl: "https://claude.ai/public/artifacts/abc",
  origin: { agentId: "agt_1", workspaceId: "wks_1", provider: "claude" },
};

describe("artifact messages", () => {
  test("gates the feature and stays absent for a daemon that predates it", () => {
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: {},
    });
    expect(legacy.features?.artifacts).toBeUndefined();

    const current = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: { artifacts: true },
    });
    expect(current.features?.artifacts).toBe(true);
  });

  test("round-trips list", () => {
    const request = {
      type: "artifact.list.request" as const,
      projectId: RECORD.projectId,
      requestId: "req_1",
    };
    expect(ArtifactListRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "artifact.list.response" as const,
      payload: {
        projectId: RECORD.projectId,
        artifacts: [RECORD],
        success: true,
        error: null,
        requestId: "req_1",
      },
    };
    expect(ArtifactListResponseSchema.parse(response)).toEqual(response);
  });

  test("carries a null companion link when the agent published no URL", () => {
    const parsed = ArtifactListResponseSchema.parse({
      type: "artifact.list.response",
      payload: {
        projectId: RECORD.projectId,
        artifacts: [{ ...RECORD, externalUrl: null }],
        success: true,
        error: null,
        requestId: "req_2",
      },
    });
    expect(parsed.payload.artifacts[0]?.externalUrl).toBeNull();
  });

  test("round-trips a download request and its metadata response", () => {
    const request = {
      type: "artifact.entry.download.request" as const,
      artifactId: RECORD.artifactId,
      requestId: "req_3",
    };
    expect(ArtifactEntryDownloadRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "artifact.entry.download.response" as const,
      payload: {
        artifactId: RECORD.artifactId,
        title: RECORD.title,
        mimeType: "text/html",
        size: 2048,
        success: true,
        error: null,
        requestId: "req_3",
      },
    };
    expect(ArtifactEntryDownloadResponseSchema.parse(response)).toEqual(response);
  });

  test("round-trips delete and pin", () => {
    const del = {
      type: "artifact.delete.request" as const,
      artifactId: RECORD.artifactId,
      requestId: "req_4",
    };
    expect(ArtifactDeleteRequestSchema.parse(del)).toEqual(del);

    const delResponse = {
      type: "artifact.delete.response" as const,
      payload: {
        artifactId: RECORD.artifactId,
        success: true,
        error: null,
        requestId: "req_4",
      },
    };
    expect(ArtifactDeleteResponseSchema.parse(delResponse)).toEqual(delResponse);

    const pin = {
      type: "artifact.pin.set.request" as const,
      artifactId: RECORD.artifactId,
      pinned: true,
      requestId: "req_5",
    };
    expect(ArtifactPinSetRequestSchema.parse(pin)).toEqual(pin);

    const pinResponse = {
      type: "artifact.pin.set.response" as const,
      payload: {
        artifact: { ...RECORD, pinned: true },
        success: true,
        error: null,
        requestId: "req_5",
      },
    };
    expect(ArtifactPinSetResponseSchema.parse(pinResponse)).toEqual(pinResponse);
  });

  test("artifact.changed is one-way: no requestId, no response half", () => {
    const changed = {
      type: "artifact.changed" as const,
      payload: { projectId: RECORD.projectId },
    };
    expect(ArtifactChangedMessageSchema.parse(changed)).toEqual(changed);
  });

  test("every artifact request parses through the inbound union", () => {
    for (const message of [
      { type: "artifact.list.request", projectId: RECORD.projectId, requestId: "r" },
      { type: "artifact.entry.download.request", artifactId: RECORD.artifactId, requestId: "r" },
      { type: "artifact.delete.request", artifactId: RECORD.artifactId, requestId: "r" },
      {
        type: "artifact.pin.set.request",
        artifactId: RECORD.artifactId,
        pinned: true,
        requestId: "r",
      },
    ]) {
      expect(SessionInboundMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  test("every artifact response parses through the outbound union", () => {
    for (const message of [
      {
        type: "artifact.list.response",
        payload: {
          projectId: RECORD.projectId,
          artifacts: [],
          success: true,
          error: null,
          requestId: "r",
        },
      },
      {
        type: "artifact.entry.download.response",
        payload: {
          artifactId: RECORD.artifactId,
          title: null,
          mimeType: null,
          size: null,
          success: false,
          error: "gone",
          requestId: "r",
        },
      },
      {
        type: "artifact.delete.response",
        payload: {
          artifactId: RECORD.artifactId,
          success: true,
          error: null,
          requestId: "r",
        },
      },
      {
        type: "artifact.pin.set.response",
        payload: { artifact: null, success: false, error: "gone", requestId: "r" },
      },
      { type: "artifact.changed", payload: { projectId: RECORD.projectId } },
    ]) {
      expect(WSOutboundMessageSchema.safeParse({ type: "session", message }).success).toBe(true);
    }
  });

  test("an unknown origin field does not break parsing for a newer peer", () => {
    const parsed = ArtifactListResponseSchema.parse({
      type: "artifact.list.response",
      payload: {
        projectId: RECORD.projectId,
        artifacts: [{ ...RECORD, origin: { ...RECORD.origin, futureField: "x" } }],
        success: true,
        error: null,
        requestId: "req_6",
      },
    });
    expect(parsed.payload.artifacts[0]?.origin.provider).toBe("claude");
  });
});
