import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import {
  LINKED_ID,
  LINK_ONLY_ID,
  OWNED_ID,
  openArtifactsPanel,
  stubArtifactRpcs,
} from "../support/helpers/artifacts";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

/**
 * Captures the Artifacts surfaces as QA evidence, per docs/qa.md — screenshots someone else can
 * look at rather than a summary that drops the detail they need.
 *
 * It asserts as it goes so a broken surface fails the run instead of quietly producing a
 * screenshot of the breakage. Files land under Playwright's per-test output directory, which is
 * gitignored; attach them to the pull request.
 */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
}

async function openWorkspaceWide(
  page: Page,
  withWorkspace: (options: { prefix: string }) => Promise<{ navigateTo: () => Promise<void> }>,
  prefix: string,
): Promise<void> {
  const workspace = await withWorkspace({ prefix });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);
}

test("evidence: desktop Explorer pane", async ({ page, withWorkspace }, testInfo) => {
  await openWorkspaceWide(page, withWorkspace, "artifacts-evidence-desktop-");

  await openArtifactsPanel(page);
  await expect(page.getByTestId("artifacts-empty").filter({ visible: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, testInfo, "01-desktop-empty-state");
});

test("evidence: desktop list and viewer", async ({ page, withWorkspace }, testInfo) => {
  await stubArtifactRpcs(page);
  await openWorkspaceWide(page, withWorkspace, "artifacts-evidence-list-");

  await openArtifactsPanel(page);
  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(list).toBeVisible({ timeout: 30_000 });
  // Three backings in one list: stored, stored-with-a-companion-link, and link-only.
  await expect(list.getByTestId(`artifact-row-${OWNED_ID}`)).toBeVisible();
  await expect(list.getByTestId(`artifact-link-${LINKED_ID}`)).toContainText("claude.ai");
  await expect(list.getByTestId(`artifact-row-${LINK_ONLY_ID}`)).toBeVisible();
  await shot(page, testInfo, "02-desktop-list");

  await list.getByTestId(`artifact-row-${OWNED_ID}`).click();
  const preview = page.getByTestId("artifact-html-preview").filter({ visible: true }).first();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview).toHaveAttribute("sandbox", "allow-scripts");
  await expect(preview.contentFrame().locator("#heading")).toHaveText("Q3 revenue");
  await shot(page, testInfo, "03-desktop-viewer");

  // The companion-link bar only renders for an artifact that has one, so the shot above cannot
  // show it. Open the one that does.
  await list.getByTestId(`artifact-row-${LINKED_ID}`).click();
  const linkBar = page.getByTestId("artifact-external-link").filter({ visible: true }).first();
  await expect(linkBar).toBeVisible({ timeout: 30_000 });
  await expect(linkBar).toContainText("claude.ai");
  await shot(page, testInfo, "04-desktop-viewer-with-companion-link");
});

test("evidence: compact overlay", async ({ page, withWorkspace }, testInfo) => {
  await stubArtifactRpcs(page);
  await openWorkspaceWide(page, withWorkspace, "artifacts-evidence-compact-");
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByTestId("workspace-explorer-toggle").first().click();
  await expect(page.getByTestId("explorer-tab-artifacts").first()).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, testInfo, "05-compact-tab-bar");

  await page.getByTestId("explorer-tab-artifacts").first().click();
  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(list).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "06-compact-list");

  await list.getByTestId(`artifact-row-${OWNED_ID}`).click();
  const preview = page.getByTestId("artifact-html-preview").filter({ visible: true }).first();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "07-compact-viewer");
});

test("evidence: launcher does not offer Artifacts in the main pane", async ({
  page,
  withWorkspace,
}, testInfo) => {
  await openWorkspaceWide(page, withWorkspace, "artifacts-evidence-launcher-");

  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
  await expect(
    page.getByTestId("workspace-new-tab-menu-agent").filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
  // Artifacts declares supportedHosts ["explorer"], so the main pane's launcher filters it out —
  // as it does Files and Changes, which are Explorer views for the same reason.
  await expect(page.getByTestId("workspace-new-tab-menu-artifacts")).toHaveCount(0);
  await expect(page.getByTestId("workspace-new-tab-menu-files")).toHaveCount(0);
  await shot(page, testInfo, "08-main-pane-launcher-excludes-artifacts");
});
