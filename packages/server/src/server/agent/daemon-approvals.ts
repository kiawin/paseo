import { randomUUID } from "node:crypto";

import type {
  AgentPermissionRequest,
  AgentPermissionRequestKind,
  AgentPermissionResponse,
  AgentProvider,
} from "./agent-sdk-types.js";

export const DAEMON_APPROVAL_REQUEST_PREFIX = "daemon-approval:";
export const DEFAULT_DAEMON_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface DaemonApprovalAgentManager {
  getAgent(agentId: string): { provider: AgentProvider } | null | undefined;
  publishDaemonApprovalRequested(agentId: string, request: AgentPermissionRequest): void;
  publishDaemonApprovalResolved(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): void;
}

interface PendingDaemonApproval {
  agentManager: DaemonApprovalAgentManager;
  agentId: string;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

const pendingApprovals = new Map<string, PendingDaemonApproval>();

export function isDaemonApprovalRequestId(requestId: string): boolean {
  return requestId.startsWith(DAEMON_APPROVAL_REQUEST_PREFIX);
}

export function isPendingDaemonApproval(
  agentManager: DaemonApprovalAgentManager,
  agentId: string,
  requestId: string,
): boolean {
  const pending = pendingApprovals.get(requestId);
  return pending?.agentManager === agentManager && pending.agentId === agentId;
}

export function requestDaemonApproval(params: {
  agentManager: DaemonApprovalAgentManager;
  agentId: string;
  kind: AgentPermissionRequestKind;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const provider = params.agentManager.getAgent(params.agentId)?.provider;
  if (!provider) throw new Error(`Agent ${params.agentId} not found`);

  const requestId = `${DAEMON_APPROVAL_REQUEST_PREFIX}${randomUUID()}`;
  if (params.signal?.aborted) return Promise.resolve(false);
  const request: AgentPermissionRequest = {
    id: requestId,
    provider,
    name: "daemon_approval",
    kind: params.kind,
    title: params.title,
    description: params.description,
    actions: [
      { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
      { id: "deny", label: "Deny", behavior: "deny", variant: "secondary" },
    ],
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };

  const promise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(
      () =>
        settleDaemonApproval(
          params.agentManager,
          requestId,
          { behavior: "deny", message: "Approval request timed out" },
          false,
        ),
      params.timeoutMs ?? DEFAULT_DAEMON_APPROVAL_TIMEOUT_MS,
    );
    const pending: PendingDaemonApproval = {
      agentManager: params.agentManager,
      agentId: params.agentId,
      resolve,
      timer,
      signal: params.signal,
    };
    if (params.signal) {
      pending.abortHandler = () =>
        settleDaemonApproval(
          params.agentManager,
          requestId,
          { behavior: "deny", message: "Tool call was abandoned" },
          false,
        );
      params.signal.addEventListener("abort", pending.abortHandler, { once: true });
    }
    pendingApprovals.set(requestId, pending);
  });

  try {
    params.agentManager.publishDaemonApprovalRequested(params.agentId, request);
  } catch (error) {
    const pending = pendingApprovals.get(requestId);
    if (pending) {
      pendingApprovals.delete(requestId);
      clearTimeout(pending.timer);
      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener("abort", pending.abortHandler);
      }
      pending.resolve(false);
    }
    throw error;
  }
  return promise;
}

export function resolveDaemonApproval(
  agentManager: DaemonApprovalAgentManager,
  agentId: string,
  requestId: string,
  response: AgentPermissionResponse,
): boolean {
  return settleDaemonApproval(
    agentManager,
    requestId,
    response,
    response.behavior === "allow",
    agentId,
  );
}

export function denyDaemonApprovalsForAgent(
  agentManager: DaemonApprovalAgentManager,
  agentId: string,
  message: string,
): void {
  for (const [requestId, pending] of pendingApprovals) {
    if (pending.agentId === agentId) {
      settleDaemonApproval(agentManager, requestId, { behavior: "deny", message }, false, agentId);
    }
  }
}

function settleDaemonApproval(
  agentManager: DaemonApprovalAgentManager,
  requestId: string,
  response: AgentPermissionResponse,
  allowed: boolean,
  expectedAgentId?: string,
): boolean {
  const pending = pendingApprovals.get(requestId);
  if (
    !pending ||
    pending.agentManager !== agentManager ||
    (expectedAgentId !== undefined && pending.agentId !== expectedAgentId)
  ) {
    return false;
  }

  pendingApprovals.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.signal && pending.abortHandler) {
    pending.signal.removeEventListener("abort", pending.abortHandler);
  }
  pending.resolve(allowed);
  agentManager.publishDaemonApprovalResolved(pending.agentId, requestId, response);
  return true;
}
