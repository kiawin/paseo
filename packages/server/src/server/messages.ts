import type { ManagedAgent } from "./agent/agent-manager.js";
import { toAgentPayload } from "./agent/agent-projections.js";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { AgentStreamEventPayloadSchema as AgentStreamEventPayloadRuntimeSchema } from "@getpaseo/protocol/messages";

export * from "@getpaseo/protocol/messages";

function validateStreamEventPayload(payload: unknown): AgentStreamEventPayload | null {
  const parsed = AgentStreamEventPayloadRuntimeSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export function serializeAgentSnapshot(
  agent: ManagedAgent,
  options?: { title?: string | null },
): AgentSnapshotPayload {
  return toAgentPayload(agent, options);
}

/**
 * COMPAT(artifactToolDetail): added in v0.7.2, remove after 2028-03-01. Clients older than the
 * artifact tool detail pin ToolCallDetail to a closed union, so one artifact item makes them
 * reject the entire message it rides in — a whole timeline page fails to load rather than one
 * row rendering plainly. plain_text is understood by every client in the field and keeps the
 * title and the link. Returns the input untouched when there is nothing to rewrite, so callers
 * can compare by identity.
 */
export function downgradeArtifactToolDetail(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "tool_call" || item.detail.type !== "artifact") return item;
  const { url, title } = item.detail;
  return {
    ...item,
    detail: { type: "plain_text", label: title ?? "Artifact", text: url },
  };
}

/** {@link downgradeArtifactToolDetail} for a serialized stream event. */
export function downgradeArtifactStreamEvent(
  event: AgentStreamEventPayload,
): AgentStreamEventPayload {
  if (event.type !== "timeline") return event;
  const item = downgradeArtifactToolDetail(event.item);
  return item === event.item ? event : { ...event, item };
}

/** {@link downgradeArtifactToolDetail} for a provider subagent timeline update. */
export function downgradeArtifactSubagentUpdate(
  message: SessionOutboundMessage,
): SessionOutboundMessage {
  if (message.type !== "agent.provider_subagents.update" || message.payload.kind !== "timeline") {
    return message;
  }
  const item = downgradeArtifactToolDetail(message.payload.item);
  return item === message.payload.item
    ? message
    : { ...message, payload: { ...message.payload, item } };
}

export function serializeAgentStreamEvent(event: AgentStreamEvent): AgentStreamEventPayload | null {
  if (event.type === "attention_required") {
    // Providers may emit attention_required without per-client notification context.
    // The websocket server emits attention_required with shouldNotify computed per client.
    // Normalize provider events so they satisfy the shared schema.
    return validateStreamEventPayload({
      type: "attention_required",
      provider: event.provider,
      reason: event.reason,
      timestamp: event.timestamp,
      shouldNotify: false,
    });
  }

  return validateStreamEventPayload(event);
}
