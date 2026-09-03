import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { ToolCallItem } from "@/types/stream";
import type { ToolCallRun } from "../grouping";
import { buildOverviewGroup } from "./model";

function toolCall(
  id: string,
  detail: ToolCallDetail,
  status: "running" | "completed" | "failed" | "canceled" = "completed",
): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(`2026-01-01T00:00:${id.padStart(2, "0")}.000Z`),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: detail.type,
        status,
        error: status === "failed" ? "boom" : null,
        detail,
      },
    },
  };
}

function run(calls: ToolCallItem[]): ToolCallRun {
  const latest = calls[calls.length - 1];
  if (!latest) {
    throw new Error("a run needs at least one call");
  }
  return { id: calls[0].id, calls, latest, isSealed: true };
}

const read: ToolCallDetail = { type: "read", filePath: "/repo/a.ts" };
const shell: ToolCallDetail = { type: "shell", command: "npm test" };

describe("buildOverviewGroup", () => {
  it("reports no failure when every call completed", () => {
    const group = buildOverviewGroup(run([toolCall("1", read), toolCall("2", shell)]));

    expect(group.hasFailure).toBe(false);
  });

  it("rolls a failed call up to the group so a collapsed run can show it", () => {
    const group = buildOverviewGroup(run([toolCall("1", read), toolCall("2", shell, "failed")]));

    expect(group.hasFailure).toBe(true);
  });

  it("does not treat a canceled call as a failure", () => {
    const group = buildOverviewGroup(run([toolCall("1", shell, "canceled")]));

    expect(group.hasFailure).toBe(false);
    expect(group.isLoading).toBe(false);
  });

  it("still reports a failure while another call is running", () => {
    const group = buildOverviewGroup(
      run([toolCall("1", shell, "failed"), toolCall("2", read, "running")]),
    );

    expect(group.hasFailure).toBe(true);
    expect(group.isLoading).toBe(true);
  });
});
