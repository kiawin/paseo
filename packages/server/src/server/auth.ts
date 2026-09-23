import { compare, hashSync } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { matchesLocalCredential } from "./local-credential.js";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

export interface DaemonAuthConfig {
  password?: string;
  localCredential?: () => string | null;
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

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compare(input.token, input.password);
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
        const localCredential = req.path === "/api/status" ? auth?.localCredential?.() : null;
        const isLocal =
          localCredential !== null &&
          localCredential !== undefined &&
          token !== null &&
          matchesLocalCredential(localCredential, token);
        if (!isLocal && !(await isBearerTokenValidAsync({ password, token }))) {
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

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const octets = ipv4.split(".");
  if (octets.length !== 4 || !octets.every((octet) => /^\d+$/.test(octet))) return false;
  const numbers = octets.map(Number);
  return numbers[0] === 127 && numbers.every((octet) => octet >= 0 && octet <= 255);
}

/**
 * Authenticates a request to the Agent MCP endpoint (/mcp/agents), which is
 * exempt from the global daemon-password middleware. A per-agent token resolves
 * to that agent; a valid daemon-password bearer resolves to the human user.
 * An uncredentialed loopback request is a user when no daemon password is
 * configured, matching the daemon's local trust boundary. Unknown credentials
 * and uncredentialed non-loopback requests are rejected.
 */
export type AgentMcpPrincipal =
  | { kind: "agent"; agentId: string }
  | { kind: "user" }
  | { kind: "reject" };

export async function resolveAgentMcpCaller(input: {
  password: string | undefined;
  authorizationHeader: string | undefined;
  daemonCapabilityToken?: string;
  resolveAgentId: (token: string) => string | undefined;
  allowAnonymousLoopback?: boolean;
}): Promise<AgentMcpPrincipal> {
  const token = extractHttpBearerToken(input.authorizationHeader);
  if (token !== null) {
    const agentId = input.resolveAgentId(token);
    if (agentId !== undefined) {
      return { kind: "agent", agentId };
    }
  }
  if (
    token !== null &&
    input.daemonCapabilityToken !== undefined &&
    tokensMatch(token, input.daemonCapabilityToken)
  ) {
    return { kind: "user" };
  }
  if (input.password && (await isBearerTokenValidAsync({ password: input.password, token }))) {
    return { kind: "user" };
  }
  if (!input.password && token === null && input.allowAnonymousLoopback) {
    return { kind: "user" };
  }
  return { kind: "reject" };
}

export function tokensMatch(providedToken: string, expectedToken: string): boolean {
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
