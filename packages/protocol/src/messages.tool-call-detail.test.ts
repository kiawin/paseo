import { describe, expect, test } from "vitest";

import type { ToolCallDetail } from "./agent-types.js";
import { AgentTimelineItemPayloadSchema } from "./messages.js";

/**
 * One sample per `ToolCallDetail` variant, keyed by discriminator.
 *
 * The `Record` is the point: adding a variant to the union stops this file compiling until a
 * sample exists, and the sample then fails to parse until the wire schema has a matching branch.
 * `ToolCallDetailPayloadSchema` is annotated `z.ZodType<ToolCallDetail, unknown>`, and a union
 * that is missing a branch still satisfies that annotation — its narrower output is assignable to
 * the wider declared type — so a missing branch typechecks and only shows up here.
 */
const SAMPLES: Record<ToolCallDetail["type"], ToolCallDetail> = {
  shell: { type: "shell", command: "ls" },
  read: { type: "read", filePath: "a.ts" },
  edit: { type: "edit", filePath: "a.ts", oldString: "a", newString: "b" },
  write: { type: "write", filePath: "a.ts", content: "x" },
  search: { type: "search", query: "needle" },
  fetch: { type: "fetch", url: "https://example.com" },
  sub_agent: { type: "sub_agent", log: "" },
  plain_text: { type: "plain_text", text: "x" },
  plan: { type: "plan", text: "x" },
  artifact: { type: "artifact", url: "https://claude.ai/code/artifact/abc", title: "Q3 revenue" },
  unknown: { type: "unknown", input: null, output: null },
  worktree_setup: {
    type: "worktree_setup",
    worktreePath: "/tmp/wt",
    branchName: "main",
    log: "",
    commands: [],
  },
};

function toolCallItem(detail: ToolCallDetail) {
  return {
    id: "itm_0123456789abcdef",
    type: "tool_call",
    callId: "call_1",
    name: "Tool",
    status: "completed",
    error: null,
    detail,
    timestamp: "2026-09-01T00:00:00.000Z",
  };
}

describe("tool call detail wire coverage", () => {
  test.each(Object.keys(SAMPLES))("a %s detail survives the timeline item schema", (type) => {
    const detail = SAMPLES[type as ToolCallDetail["type"]];
    const parsed = AgentTimelineItemPayloadSchema.safeParse(toolCallItem(detail));
    expect(parsed.success).toBe(true);
  });

  test("an unrecognised detail type is rejected rather than passed through", () => {
    const parsed = AgentTimelineItemPayloadSchema.safeParse(
      toolCallItem({ type: "not_a_detail" } as unknown as ToolCallDetail),
    );
    expect(parsed.success).toBe(false);
  });
});
