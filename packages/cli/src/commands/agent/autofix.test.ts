import { describe, expect, it } from "vitest";
import { parseAutofixAction, toAutofixResult } from "./autofix.js";

describe("agent autofix", () => {
  it("defaults to showing status and rejects unknown actions", () => {
    expect(parseAutofixAction(undefined)).toBe("status");
    expect(parseAutofixAction("on")).toBe("on");
    expect(() => parseAutofixAction("enable")).toThrow();
  });

  it("describes a watch, including why it paused", () => {
    expect(toAutofixResult("agent-1", null)).toEqual({
      agentId: "agent-1",
      state: "off",
      pr: "-",
      attempts: "-",
    });
    expect(
      toAutofixResult("agent-1", {
        agentId: "agent-1",
        cwd: "/repo",
        forge: "github",
        prNumber: 42,
        prUrl: "https://github.com/acme/widgets/pull/42",
        state: { kind: "paused", reason: "attempt_limit", at: "2026-10-17T00:00:00.000Z" },
        headSha: "abc",
        attemptsForHead: 3,
        maxAttemptsPerHead: 3,
        updatedAt: "2026-10-17T00:00:00.000Z",
      }),
    ).toEqual({
      agentId: "agent-1",
      state: "paused (attempt_limit)",
      pr: "https://github.com/acme/widgets/pull/42",
      attempts: "3/3",
    });
  });
});
