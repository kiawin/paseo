import path from "node:path";

import { expect, test } from "../support/fixtures";
import { submitMessage } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openArtifactsPanel, waitForCompactExplorerSettled } from "../support/helpers/artifacts";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

// Spelled out rather than imported from the server package, matching the other mock-command
// specs. Source: MOCK_LOAD_TEST_PUBLISH_ARTIFACT_COMMAND in mock-load-test-agent.ts.
const PUBLISH_ARTIFACT_COMMAND = "/mock publish-artifact";
const ARTIFACT_TITLE = "Mock published artifact";
const EVIDENCE_DIR = path.resolve(__dirname, "../../../..", "qa-evidence");

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

test("pin QA: real daemon ordering, persistence, and compact layout", async ({
  page,
}, testInfo) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `artifacts-pin-evidence-${testInfo.workerIndex}-`,
    title: "Artifact publisher",
  });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: false });
  };
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });

    const published = page.getByText("Mock artifact published", { exact: true });
    await submitMessage(page, PUBLISH_ARTIFACT_COMMAND);
    await expect(published).toHaveCount(1, { timeout: 60_000 });

    await openArtifactsPanel(page);
    const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
    const rows = list.getByTestId(/^artifact-row-/);
    await expect(rows).toHaveCount(1, { timeout: 30_000 });

    // Publishing while the list is open must arrive through the owned invalidation subscription.
    await submitMessage(page, PUBLISH_ARTIFACT_COMMAND);
    await expect(published).toHaveCount(2, { timeout: 60_000 });
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    const newer = await rows.first().getAttribute("data-testid");
    const older = await rows.nth(1).getAttribute("data-testid");
    if (!newer || !older) throw new Error("Artifact rows lack test IDs");
    const olderId = older.replace("artifact-row-", "");
    const rowHeightBefore = await rows
      .nth(1)
      .evaluate((element) => element.getBoundingClientRect().height);
    const workspace = (await agent.client.fetchWorkspaces()).entries.find(
      (entry) => entry.id === agent.workspaceId,
    );
    if (!workspace) throw new Error("Agent workspace is missing");
    await shot("pin-01-desktop-before");

    await rows.nth(1).click({ button: "right" });
    const pinAction = page.getByTestId(`artifact-pin-${olderId}`);
    await expect(pinAction).toContainText("Pin to top");
    await expect(page.getByTestId(`artifact-menu-${olderId}`)).toHaveCSS("opacity", "1");
    await shot("pin-02-desktop-menu");
    await pinAction.click();
    await expect
      .poll(async () => {
        const records = await agent.client.listArtifacts(workspace.projectId);
        return records.map((record) => ({ id: record.artifactId, pinned: record.pinned }));
      })
      .toEqual([
        { id: olderId, pinned: true },
        { id: newer.replace("artifact-row-", ""), pinned: false },
      ]);
    await expect(rows.first()).toHaveAttribute("data-testid", older);
    await expect(rows.first()).toHaveAttribute("aria-label", `${ARTIFACT_TITLE}, Pinned`);
    expect(await rows.first().evaluate((element) => element.getBoundingClientRect().height)).toBe(
      rowHeightBefore,
    );
    await shot("pin-03-desktop-pinned");

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWorkspaceTabsVisible(page);
    await openArtifactsPanel(page);
    const reloadedList = page.getByTestId("artifacts-list").filter({ visible: true }).first();
    const reloadedRows = reloadedList.getByTestId(/^artifact-row-/);
    await expect(reloadedRows.first()).toHaveAttribute("data-testid", older);
    await shot("pin-04-desktop-after-reload");

    await reloadedRows.first().click({ button: "right" });
    const unpinAction = page.getByTestId(`artifact-pin-${olderId}`);
    await expect(unpinAction).toContainText("Unpin");
    await unpinAction.click();
    await expect(reloadedRows.first()).toHaveAttribute("data-testid", newer);
    await shot("pin-05-desktop-unpinned");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await page.getByTestId("explorer-tab-artifacts").first().click();
    await waitForCompactExplorerSettled(page);
    const compactList = page.getByTestId("artifacts-list").filter({ visible: true }).first();
    const compactRows = compactList.getByTestId(/^artifact-row-/);
    await expect(compactRows.first()).toHaveAttribute("data-testid", newer);
    await compactRows.nth(1).click({ button: "right" });
    await expect(page.getByTestId(`artifact-pin-${olderId}`)).toBeVisible();
    const compactMenu = page.getByTestId(`artifact-menu-${olderId}-content`);
    await waitForSettledPosition(compactMenu);
    await expect
      .poll(async () => (await page.getByTestId(`artifact-pin-${olderId}`).boundingBox())?.y ?? 844)
      .toBeLessThan(800);
    await shot("pin-06-compact-menu");
    await page.getByTestId(`artifact-pin-${olderId}`).click();
    await expect(compactRows.first()).toHaveAttribute("data-testid", older);
    await expect(compactMenu).not.toBeVisible();
    await shot("pin-07-compact-pinned");
  } catch (error) {
    await shot("pin-qa-failure");
    throw error;
  } finally {
    await agent.cleanup();
  }
});

test("rename QA: user title persists and can be restored", async ({ page }, testInfo) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `artifacts-rename-evidence-${testInfo.workerIndex}-`,
    title: "Artifact publisher",
  });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: false });
  };
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await submitMessage(page, PUBLISH_ARTIFACT_COMMAND);
    await expect(page.getByText("Mock artifact published", { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    await openArtifactsPanel(page);
    const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
    const row = list.getByTestId(/^artifact-row-/).first();
    await expect(row).toContainText(ARTIFACT_TITLE);
    const rowId = await row.getAttribute("data-testid");
    if (!rowId) throw new Error("Artifact row lacks a test ID");
    const artifactId = rowId.replace("artifact-row-", "");
    await shot("rename-01-desktop-original");

    await row.click({ button: "right" });
    await expect(page.getByTestId(`artifact-menu-${artifactId}`)).toHaveCSS("opacity", "1");
    await shot("rename-02-desktop-menu");
    await page.getByTestId(`artifact-rename-${artifactId}`).click();
    const modalId = `artifact-rename-modal-${artifactId}`;
    await page.getByTestId(`${modalId}-input`).fill("Facilities handover");
    await shot("rename-03-desktop-editor");
    await page.getByTestId(`${modalId}-submit`).click();
    await expect(row).toContainText("Facilities handover");

    const workspace = (await agent.client.fetchWorkspaces()).entries.find(
      (entry) => entry.id === agent.workspaceId,
    );
    if (!workspace) throw new Error("Agent workspace is missing");
    expect((await agent.client.listArtifacts(workspace.projectId))[0]).toMatchObject({
      artifactId,
      title: ARTIFACT_TITLE,
      customTitle: "Facilities handover",
    });
    await row.click();
    const viewerTab = page.getByTestId(`workspace-tab-artifact_${artifactId}`).first();
    await expect(viewerTab).toContainText("Facilities handover");
    await shot("rename-04-desktop-renamed");

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWorkspaceTabsVisible(page);
    await openArtifactsPanel(page);
    const reloadedRow = page
      .getByTestId(`artifact-row-${artifactId}`)
      .filter({ visible: true })
      .first();
    await expect(reloadedRow).toContainText("Facilities handover");
    await shot("rename-05-desktop-after-reload");

    await reloadedRow.click({ button: "right" });
    await page.getByTestId(`artifact-reset-title-${artifactId}`).click();
    await expect(reloadedRow).toContainText(ARTIFACT_TITLE);
    await expect(viewerTab).toContainText(ARTIFACT_TITLE);
    expect((await agent.client.listArtifacts(workspace.projectId))[0]?.customTitle).toBeUndefined();
    await shot("rename-06-desktop-reset");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await page.getByTestId("explorer-tab-artifacts").first().click();
    await waitForCompactExplorerSettled(page);
    const compactRow = page
      .getByTestId(`artifact-row-${artifactId}`)
      .filter({ visible: true })
      .first();
    await compactRow.click({ button: "right" });
    await page.getByTestId(`artifact-rename-${artifactId}`).click();
    const compactInput = page.getByTestId(`${modalId}-input`);
    await expect(compactInput).toBeVisible();
    await waitForSettledPosition(compactInput);
    await compactInput.fill("Compact facilities handover");
    await shot("rename-07-compact-editor");
    await compactInput.press("Tab");
    await waitForSettledPosition(page.getByTestId(modalId));
    await shot("rename-08-compact-editor-after-focus");
    await page.getByTestId(`${modalId}-submit`).click();
    await expect(compactInput).not.toBeVisible();
    await expect(compactRow).toContainText("Compact facilities handover");
    await shot("rename-09-compact-renamed");
  } finally {
    await agent.cleanup();
  }
});

test("search QA: real daemon title and document text", async ({ page }, testInfo) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `artifacts-search-evidence-${testInfo.workerIndex}-`,
    title: "Artifact publisher",
  });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: false });
  };
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await submitMessage(page, PUBLISH_ARTIFACT_COMMAND);
    await expect(page.getByText("Mock artifact published", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await openArtifactsPanel(page);

    const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
    const row = list.getByTestId(/^artifact-row-/).first();
    await expect(row).toContainText(ARTIFACT_TITLE);
    const rowId = await row.getAttribute("data-testid");
    if (!rowId) throw new Error("Artifact row lacks a test ID");
    const artifactId = rowId.replace("artifact-row-", "");
    const snippet = page.getByTestId(`artifact-snippet-${artifactId}`);
    const search = page.getByTestId("artifacts-search").filter({ visible: true }).first();
    await shot("search-01-desktop-unfiltered");

    await search.fill("mOcK");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("artifacts-search-status")).toBeVisible();
    await expect(page.getByTestId("artifacts-search-status")).not.toBeVisible();
    await shot("search-02-desktop-title-match");

    await search.fill("daemon");
    await expect(row).toBeVisible();
    await expect(snippet).toContainText("Stored by the daemon");
    await shot("search-03-desktop-text-match");

    await search.fill("not-present-anywhere");
    await expect(page.getByTestId("artifacts-no-results")).toContainText("No results found");
    await shot("search-04-desktop-no-results");

    await search.fill("");
    await expect(row).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await page.getByTestId("explorer-tab-artifacts").first().click();
    await waitForCompactExplorerSettled(page);
    const compactSearch = page.getByTestId("artifacts-search").filter({ visible: true }).first();
    await compactSearch.fill("daemon");
    await expect(
      page.getByTestId(`artifact-row-${artifactId}`).filter({ visible: true }),
    ).toBeVisible();
    await expect(snippet.filter({ visible: true })).toContainText("Stored by the daemon");
    await shot("search-05-compact-text-match");
  } finally {
    await agent.cleanup();
  }
});
