import { expect, test } from "../support/fixtures";
import { submitMessage } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openArtifactsPanel } from "../support/helpers/artifacts";

// Spelled out rather than imported from the server package, matching the other mock-command
// specs. Source: MOCK_LOAD_TEST_PUBLISH_ARTIFACT_COMMAND in mock-load-test-agent.ts.
const PUBLISH_ARTIFACT_COMMAND = "/mock publish-artifact";
const ARTIFACT_TITLE = "Mock published artifact";

// The tool catalog is what the agent publishes through, and the worker daemon only injects it
// when asked.
test.use({ e2eInjectPaseoTools: true });

/**
 * The publish path end to end, with nothing stubbed: a real agent calls the real
 * `publish_artifact` tool, the daemon stores real bytes, the list invalidation is pushed to the
 * app, and the viewer streams the document back over the binary channel.
 *
 * The mock provider takes the Paseo tool catalog natively so a test can drive a tool call
 * without a live model.
 */
test("an agent publishes an artifact and it appears in the project", async ({ page }, testInfo) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `artifacts-publish-${testInfo.workerIndex}-`,
    title: "Artifact publisher",
  });
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });

    await test.step("Publish through the tool", async () => {
      await submitMessage(page, PUBLISH_ARTIFACT_COMMAND);
      await expect(page.getByText("Mock artifact published", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("The list picks it up from the daemon's push", async () => {
      await openArtifactsPanel(page);
      const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
      await expect(list).toBeVisible({ timeout: 30_000 });
      await expect(list).toContainText(ARTIFACT_TITLE);
    });

    await test.step("The stored bytes render in the sandboxed preview", async () => {
      await page
        .locator('[data-testid^="artifact-row-"]')
        .filter({ visible: true })
        .first()
        .click();
      const preview = page.getByTestId("artifact-html-preview").filter({ visible: true }).first();
      await expect(preview).toBeVisible({ timeout: 30_000 });
      await expect(preview).toHaveAttribute("sandbox", "allow-scripts");
      await expect(preview.contentFrame().locator("#heading")).toHaveText("Published by an agent");
      await page.screenshot({ path: testInfo.outputPath("12-published-by-an-agent.png") });
    });
  } finally {
    await agent.cleanup();
  }
});
