import { test, expect } from "../support/fixtures";
import {
  LINKED_ID,
  LINK_ONLY_ID,
  LINK_ONLY_URL,
  OWNED_ID,
  openArtifactsPanel,
  stubArtifactRpcs,
} from "../support/helpers/artifacts";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

test("the Artifacts view reports an empty project against the real daemon", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "artifacts-empty-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);

  // Reaching the empty state rather than the unsupported one proves the daemon advertised
  // `features.artifacts` and answered a real artifact.list round trip.
  const empty = page.getByTestId("artifacts-empty").filter({ visible: true }).first();
  await expect(empty).toBeVisible({ timeout: 30_000 });
  await expect(empty).toContainText("No artifacts in this project");
  await expect(page.getByTestId("artifacts-unsupported")).toHaveCount(0);
});

test("an artifact opens into the sandboxed preview and shows its companion link host", async ({
  page,
  withWorkspace,
}) => {
  await stubArtifactRpcs(page);
  const workspace = await withWorkspace({ prefix: "artifacts-view-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);

  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(list).toContainText("Q3 revenue dashboard");
  await expect(list).toContainText("Migration risk report");

  // The companion link is labelled with its hostname, so the destination of an
  // agent-supplied URL is visible before the tap.
  await expect(list.getByTestId(`artifact-link-${LINKED_ID}`)).toContainText("claude.ai");

  await list.getByTestId(`artifact-row-${OWNED_ID}`).click();

  const preview = page.getByTestId("artifact-html-preview").filter({ visible: true }).first();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  // Reused unchanged from the file pane: scripts only, no popups, opaque origin.
  await expect(preview).toHaveAttribute("sandbox", "allow-scripts");
  await expect(preview.contentFrame().locator("#heading")).toHaveText("Q3 revenue");
});

test("the compact overlay lists artifacts from its own header tab", async ({
  page,
  withWorkspace,
}) => {
  await stubArtifactRpcs(page);
  const workspace = await withWorkspace({ prefix: "artifacts-compact-" });
  // Navigate at desktop width: the compact sidebar is an overlay, so the project row the
  // helper clicks is not on screen at phone width.
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByTestId("workspace-explorer-toggle").first().click();
  // Unconditional, unlike Changes and PR: artifacts are project-scoped, so the tab is present
  // whatever the workspace's git state.
  await page.getByTestId("explorer-tab-artifacts").first().click();

  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(list).toContainText("Q3 revenue dashboard");

  await list.getByTestId(`artifact-row-${OWNED_ID}`).click();

  const preview = page.getByTestId("artifact-html-preview").filter({ visible: true }).first();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview.contentFrame().locator("#heading")).toHaveText("Q3 revenue");
});

test("a link-only artifact opens its destination instead of an empty preview", async ({
  page,
  withWorkspace,
}) => {
  await stubArtifactRpcs(page);
  const workspace = await withWorkspace({ prefix: "artifacts-link-only-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);
  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(list).toBeVisible({ timeout: 30_000 });

  // No size in the meta line: the daemon holds no bytes for this one.
  const row = list.getByTestId(`artifact-row-${LINK_ONLY_ID}`);
  await expect(row).toContainText("Published on claude.ai");
  await expect(row).not.toContainText("KB");
  await expect(row).not.toContainText("MB");

  const popup = page.waitForEvent("popup");
  await row.click();
  expect((await popup).url()).toBe(LINK_ONLY_URL);

  // And it must not have opened the viewer, which would render an empty document.
  await expect(page.getByTestId("artifact-html-preview")).toHaveCount(0);
});
