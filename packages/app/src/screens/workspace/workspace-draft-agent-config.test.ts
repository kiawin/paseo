import { describe, expect, it } from "vitest";
import { buildWorkspaceDraftAgentConfig } from "./workspace-draft-agent-config";

describe("workspace-draft-agent-config", () => {
  it("builds chat-only config for workspace draft agents", () => {
    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "codex",
        cwd: "/tmp/project",
        modeId: "auto",
        model: "gpt-5.4",
        thinkingOptionId: "high",
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "auto",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });
  });

  it("sends profile instructions as the system prompt and omits a blank one", () => {
    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "claude",
        cwd: "/tmp/project",
        systemPrompt: "Review the diff.",
      }),
    ).toEqual({ provider: "claude", cwd: "/tmp/project", systemPrompt: "Review the diff." });
    expect(
      buildWorkspaceDraftAgentConfig({ provider: "claude", cwd: "/tmp/project", systemPrompt: "" }),
    ).not.toHaveProperty("systemPrompt");
  });
});
