import { compare, compareSync, hashSync } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

export interface DaemonAuthConfig {
  password?: string;
}

export interface BearerAuthRejectContext {
  path: string;
  method: string;
  hasToken: boolean;
}

interface BearerValidationInput {
  password: string | undefined;
  token: string | null;
}

export function isBearerTokenValid(input: BearerValidationInput): boolean {
  return isBearerTokenValidSync(input);
}

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compare(input.token, input.password);
}

export function isBearerTokenValidSync(input: BearerValidationInput): boolean {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compareSync(input.token, input.password);
}

export function hashDaemonPassword(password: string): string {
  return hashSync(password, DAEMON_PASSWORD_BCRYPT_COST);
}

export function extractHttpBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const [scheme, ...tokenParts] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || tokenParts.length !== 1) {
    return null;
  }
  return tokenParts[0] ?? null;
}

export function extractWsBearerProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    const segments = trimmed.split(".");
    if (segments[0] === "paseo" && segments[1] === "bearer" && segments.length >= 3) {
      return trimmed;
    }
  }

  return null;
}

export function extractWsBearerToken(protocol: string | null): string | null {
  if (!protocol) {
    return null;
  }
  const segments = protocol.split(".");
  if (segments[0] !== "paseo" || segments[1] !== "bearer" || segments.length < 3) {
    return null;
  }
  return segments.slice(2).join(".");
}

export function createRequireBearerMiddleware(
  auth: DaemonAuthConfig | undefined,
  onReject?: (context: BearerAuthRejectContext) => void,
): RequestHandler {
  const password = auth?.password;
  return (req, res, next) => {
    if (!password || shouldBypassBearerAuth(req.method, req.path)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = extractHttpBearerToken(req.header("authorization"));
        if (!(await isBearerTokenValidAsync({ password, token }))) {
          onReject?.({
            path: req.path,
            method: req.method,
            hasToken: token !== null,
          });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

const SELF_AUTHENTICATING_ROUTES = new Set(["/api/files/download", "/mcp/agents"]);

function isBearerFreeRoute(path: string): boolean {
  return path === "/api/health" || SELF_AUTHENTICATING_ROUTES.has(path);
}

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  return isBearerFreeRoute(path);
}

/**
 * Authenticates a request to the Agent MCP endpoint (/mcp/agents), which is
 * exempt from the global daemon-password middleware. A per-agent token resolves
 * to that agent; a valid daemon-password bearer resolves to the human user.
 * Missing credentials remain top-level user access when no daemon password is
 * configured, matching the daemon's passwordless behavior. Unknown credentials
 * are rejected when a password is configured.
 */
export type AgentMcpPrincipal =
  | { kind: "agent"; agentId: string }
  | { kind: "user" }
  | { kind: "reject" };

export async function resolveAgentMcpCaller(input: {
  password: string | undefined;
  authorizationHeader: string | undefined;
  resolveAgentId: (token: string) => string | undefined;
}): Promise<AgentMcpPrincipal> {
  const token = extractHttpBearerToken(input.authorizationHeader);
  if (token !== null) {
    const agentId = input.resolveAgentId(token);
    if (agentId !== undefined) {
      return { kind: "agent", agentId };
    }
  }
  if (!input.password) {
    return { kind: "user" };
  }
  if (input.password && (await isBearerTokenValidAsync({ password: input.password, token }))) {
    return { kind: "user" };
  }
  return { kind: "reject" };
}

export function tokensMatch(providedToken: string, expectedToken: string): boolean {
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
