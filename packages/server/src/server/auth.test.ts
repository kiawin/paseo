import { describe, expect, test } from "vitest";

import {
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  hashDaemonPassword,
  resolveAgentMcpCaller,
  isBearerTokenValidAsync,
  isBearerTokenValid,
  shouldBypassBearerAuth,
} from "./auth.js";

const CORRECT_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

describe("daemon bearer validator", () => {
  test("allows any token when no password is configured", () => {
    expect(isBearerTokenValid({ password: undefined, token: null })).toBe(true);
    expect(isBearerTokenValid({ password: undefined, token: "anything" })).toBe(true);
  });

  test("accepts the plaintext token against the bcrypt hash and rejects missing or wrong tokens", async () => {
    expect(
      await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "correct-password" }),
    ).toBe(true);
    expect(isBearerTokenValid({ password: CORRECT_PASSWORD_HASH, token: "correct-password" })).toBe(
      true,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: null })).toBe(
      false,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "wrong" })).toBe(
      false,
    );
  });

  test("hashes a password into a bcrypt value", () => {
    const hash = hashDaemonPassword("correct-password");

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(isBearerTokenValid({ password: hash, token: "correct-password" })).toBe(true);
  });

  test("extracts HTTP bearer tokens", () => {
    expect(extractHttpBearerToken("Bearer secret")).toBe("secret");
    expect(extractHttpBearerToken("Basic secret")).toBeNull();
    expect(extractHttpBearerToken(undefined)).toBeNull();
  });

  test("extracts WebSocket paseo bearer subprotocol tokens", () => {
    const protocol = extractWsBearerProtocol("chat, paseo.bearer.secret.with.dots");

    expect(protocol).toBe("paseo.bearer.secret.with.dots");
    expect(extractWsBearerToken(protocol)).toBe("secret.with.dots");
    expect(extractWsBearerToken("paseo.other.secret")).toBeNull();
  });

  test("bypasses bearer auth for preflight, liveness, and capability-token routes", () => {
    // Preflight is always bypassed regardless of path.
    expect(shouldBypassBearerAuth("OPTIONS", "/api/status")).toBe(true);
    // Unauthenticated liveness probe.
    expect(shouldBypassBearerAuth("GET", "/api/health")).toBe(true);
    // Guarded by its own single-use download token, not the daemon password.
    expect(shouldBypassBearerAuth("GET", "/api/files/download")).toBe(true);
    // Guarded by its own per-daemon-run capability token (see
    // resolveAgentMcpCaller), not the daemon password.
    expect(shouldBypassBearerAuth("POST", "/mcp/agents")).toBe(true);
    // Everything else stays behind the daemon password.
    expect(shouldBypassBearerAuth("GET", "/api/status")).toBe(false);
    expect(shouldBypassBearerAuth("POST", "/api/files/upload")).toBe(false);
  });
});

describe("agent MCP request authorizer", () => {
  const CAPABILITY_TOKEN = "cap-token-abc123";
  const resolveAgentId = (token: string) => (token === CAPABILITY_TOKEN ? "agent-1" : undefined);

  test("allows the top-level user when no daemon password is configured", async () => {
    expect(
      await resolveAgentMcpCaller({
        password: undefined,
        authorizationHeader: undefined,
        resolveAgentId,
      }),
    ).toEqual({ kind: "user" });
  });

  test("resolves the injected capability token to its agent", async () => {
    expect(
      await resolveAgentMcpCaller({
        password: CORRECT_PASSWORD_HASH,
        authorizationHeader: `Bearer ${CAPABILITY_TOKEN}`,
        resolveAgentId,
      }),
    ).toEqual({ kind: "agent", agentId: "agent-1" });
  });

  test("resolves each agent token independently", async () => {
    const resolveBothAgentIds = (token: string) => {
      if (token === "agent-token-1") return "agent-1";
      if (token === "agent-token-2") return "agent-2";
      return undefined;
    };
    await expect(
      resolveAgentMcpCaller({
        password: undefined,
        authorizationHeader: "Bearer agent-token-1",
        resolveAgentId: resolveBothAgentIds,
      }),
    ).resolves.toEqual({ kind: "agent", agentId: "agent-1" });
    await expect(
      resolveAgentMcpCaller({
        password: undefined,
        authorizationHeader: "Bearer agent-token-2",
        resolveAgentId: resolveBothAgentIds,
      }),
    ).resolves.toEqual({ kind: "agent", agentId: "agent-2" });
  });

  test("resolves a valid daemon-password bearer to the human user", async () => {
    expect(
      await resolveAgentMcpCaller({
        password: CORRECT_PASSWORD_HASH,
        authorizationHeader: "Bearer correct-password",
        resolveAgentId,
      }),
    ).toEqual({ kind: "user" });
  });

  test("rejects requests presenting neither the token nor a valid password", async () => {
    expect(
      await resolveAgentMcpCaller({
        password: CORRECT_PASSWORD_HASH,
        authorizationHeader: undefined,
        resolveAgentId,
      }),
    ).toEqual({ kind: "reject" });
    expect(
      await resolveAgentMcpCaller({
        password: CORRECT_PASSWORD_HASH,
        authorizationHeader: "Bearer wrong-token",
        resolveAgentId,
      }),
    ).toEqual({ kind: "reject" });
  });

  test("ignores callerAgentId in the URL because identity comes from the token", async () => {
    expect(
      await resolveAgentMcpCaller({
        password: CORRECT_PASSWORD_HASH,
        authorizationHeader: `Bearer ${CAPABILITY_TOKEN}`,
        resolveAgentId,
      }),
    ).toEqual({ kind: "agent", agentId: "agent-1" });
  });
});
