import path from "node:path";
import { test, expect } from "../support/fixtures";
import { awaitToolCall } from "../support/helpers/agent-stream";
import { openAgentRoute, seedRunningMockAgentWorkspace } from "../support/helpers/mock-agent";

/**
 * Capture-only spec for docs/refactors/chat-trace-presentation-plan.md. The mock provider's
 * realistic cycle emits read → grep → edit (with a unified diff) → bash, which is the same node
 * vocabulary the plan's reference transcript uses, so one turn covers every row the plan wants
 * to compare against. Delete this file once the plan's open questions are closed.
 */

const EVIDENCE_DIR = path.resolve(process.cwd(), "../../qa-evidence/chat-trace");

test("captures the current chat rendering of a realistic mock turn", async ({ page }) => {
  test.setTimeout(180_000);
  const agent = await seedRunningMockAgentWorkspace({
    repoPrefix: "chat-trace-baseline-",
    title: "Chat trace baseline",
    model: "one-minute-stream",
    initialPrompt: "Stream a realistic turn for chat trace presentation baseline capture.",
  });

  try {
    await openAgentRoute(page, agent);
    await awaitToolCall(page, /edit/i);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, "01-turn.png"), fullPage: true });

    const editBadge = page.getByTestId("tool-call-badge").filter({ hasText: /edit/i }).first();
    await editBadge.scrollIntoViewIfNeeded();
    await expect(editBadge).toBeVisible();
    await editBadge.screenshot({ path: path.join(EVIDENCE_DIR, "02-edit-row-collapsed.png") });

    await editBadge.click();
    await expect(editBadge).toContainText(/[+-]/, { timeout: 15_000 });
    await editBadge.screenshot({ path: path.join(EVIDENCE_DIR, "03-edit-row-expanded.png") });

    const userMessage = page.getByTestId("user-message").first();
    await userMessage.scrollIntoViewIfNeeded();
    await userMessage.screenshot({ path: path.join(EVIDENCE_DIR, "04-user-message.png") });
  } finally {
    await agent.cleanup();
  }
});
