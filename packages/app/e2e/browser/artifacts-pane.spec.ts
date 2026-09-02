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

test("artifact titles can be searched and the full list restored", async ({
  page,
  withWorkspace,
}) => {
  await stubArtifactRpcs(page);
  const workspace = await withWorkspace({ prefix: "artifacts-search-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);

  const search = page.getByTestId("artifacts-search").filter({ visible: true }).first();
  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(search).toBeVisible({ timeout: 30_000 });
  await expect(search).toHaveAttribute("placeholder", "Search titles and document text");
  await search.fill("  RISK migration  ");
  await expect(list.getByTestId(`artifact-row-${LINKED_ID}`)).toBeVisible();
  await expect(list.getByTestId(`artifact-row-${OWNED_ID}`)).toHaveCount(0);
  await expect(list.getByTestId(`artifact-row-${LINK_ONLY_ID}`)).toHaveCount(0);

  await search.fill("visitor");
  await expect(list.getByTestId(`artifact-row-${OWNED_ID}`)).toBeVisible();
  await expect(list.getByTestId(`artifact-snippet-${OWNED_ID}`)).toContainText(
    "Visitor conversion increased",
  );
  await expect(list.getByTestId(`artifact-row-${LINKED_ID}`)).toHaveCount(0);

  await search.fill("missing title");
  await expect(page.getByTestId("artifacts-no-results")).toContainText("No results found");

  await search.fill("");
  await expect(list.getByTestId(`artifact-row-${OWNED_ID}`)).toBeVisible();
  await expect(list.getByTestId(`artifact-row-${LINKED_ID}`)).toBeVisible();
  await expect(list.getByTestId(`artifact-row-${LINK_ONLY_ID}`)).toBeVisible();
});

test("a failed document search can be retried without losing the query", async ({
  page,
  withWorkspace,
}) => {
  await stubArtifactRpcs(page, { failSearchOnce: true });
  const workspace = await withWorkspace({ prefix: "artifacts-search-retry-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);
  const search = page.getByTestId("artifacts-search").filter({ visible: true }).first();
  await search.fill("visitor");
  await expect(page.getByTestId("artifacts-search-error")).toContainText(
    "Could not search document text.",
  );
  await page.getByTestId("artifacts-search-retry").click();

  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(list.getByTestId(`artifact-row-${OWNED_ID}`)).toBeVisible();
  await expect(list.getByTestId(`artifact-snippet-${OWNED_ID}`)).toContainText(
    "Visitor conversion increased",
  );
  await expect(search).toHaveValue("visitor");
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

  await openArtifactsPanel(page);

  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(list).toContainText("Q3 revenue dashboard");

  const search = page.getByTestId("artifacts-search").filter({ visible: true }).first();
  await search.fill("migration");
  await expect(list.getByTestId(`artifact-row-${LINKED_ID}`)).toBeVisible();
  await expect(list.getByTestId(`artifact-row-${OWNED_ID}`)).toHaveCount(0);
  await search.fill("");
  await expect(list.getByTestId(`artifact-row-${OWNED_ID}`)).toBeVisible();

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

test("pinning moves an artifact to the top and unpinning restores its order", async ({
  page,
  withWorkspace,
}) => {
  await stubArtifactRpcs(page, { failPinOnce: true });
  const workspace = await withWorkspace({ prefix: "artifacts-pin-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);
  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  const rows = list.getByTestId(/^artifact-row-/);
  const owned = list.getByTestId(`artifact-row-${OWNED_ID}`);
  const pinAction = page.getByTestId(`artifact-pin-${OWNED_ID}`);
  await expect(rows.first()).toHaveAttribute("data-testid", `artifact-row-${LINKED_ID}`);

  await owned.click({ button: "right" });
  await expect(pinAction).toContainText("Pin to top");
  await pinAction.click();
  await expect(page.getByText("Could not update artifact pin.")).toBeVisible();
  await expect(rows.first()).toHaveAttribute("data-testid", `artifact-row-${LINKED_ID}`);

  await owned.click({ button: "right" });
  await pinAction.click();
  await expect(rows.first()).toHaveAttribute("data-testid", `artifact-row-${OWNED_ID}`);
  await expect(owned).toHaveAttribute("aria-label", "Q3 revenue dashboard, Pinned");

  await owned.click({ button: "right" });
  await expect(pinAction).toContainText("Unpin");
  await pinAction.click();
  await expect(rows.first()).toHaveAttribute("data-testid", `artifact-row-${LINKED_ID}`);
});

test("an artifact can be renamed, searched by either title, and reset", async ({
  page,
  withWorkspace,
}) => {
  await stubArtifactRpcs(page, { failRenameOnce: true });
  const workspace = await withWorkspace({ prefix: "artifacts-rename-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);
  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  const row = list.getByTestId(`artifact-row-${OWNED_ID}`);
  await row.click({ button: "right" });
  await page.getByTestId(`artifact-rename-${OWNED_ID}`).click();

  const modalId = `artifact-rename-modal-${OWNED_ID}`;
  const input = page.getByTestId(`${modalId}-input`);
  await expect(input).toHaveValue("Q3 revenue dashboard");
  await input.fill("Quarterly revenue plan");
  await page.getByTestId(`${modalId}-submit`).click();
  await expect(page.getByTestId(`${modalId}-error`)).toContainText("Could not rename artifact");
  await expect(input).toHaveValue("Quarterly revenue plan");
  await page.getByTestId(`${modalId}-submit`).click();
  await expect(row).toContainText("Quarterly revenue plan");
  await expect(row).toHaveAttribute("aria-label", "Quarterly revenue plan");

  const search = page.getByTestId("artifacts-search").filter({ visible: true }).first();
  await search.fill("quarterly");
  await expect(row).toBeVisible();
  await search.fill("Q3 revenue");
  await expect(row).toBeVisible();
  await search.fill("");

  await row.click({ button: "right" });
  await page.getByTestId(`artifact-reset-title-${OWNED_ID}`).click();
  await expect(row).toContainText("Q3 revenue dashboard");
  await expect(row).toHaveAttribute("aria-label", "Q3 revenue dashboard");
});

test("the compact artifact menu opens the rename editor", async ({ page, withWorkspace }) => {
  await stubArtifactRpcs(page);
  const workspace = await withWorkspace({ prefix: "artifacts-rename-compact-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openArtifactsPanel(page);

  const row = page.getByTestId(`artifact-row-${OWNED_ID}`).filter({ visible: true }).first();
  await row.click({ button: "right" });
  await page.getByTestId(`artifact-rename-${OWNED_ID}`).click();
  const modalId = `artifact-rename-modal-${OWNED_ID}`;
  const input = page.getByTestId(`${modalId}-input`);
  await expect(input).toBeVisible();
  await input.fill("Compact facilities plan");
  await page.getByTestId(`${modalId}-submit`).click();
  await expect(row).toContainText("Compact facilities plan");
});

test("an artifact can be deleted from its context menu", async ({ page, withWorkspace }) => {
  await stubArtifactRpcs(page);
  const workspace = await withWorkspace({ prefix: "artifacts-delete-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);
  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(list).toBeVisible({ timeout: 30_000 });

  const row = list.getByTestId(`artifact-row-${OWNED_ID}`);
  await row.click({ button: "right" });
  const menu = page.getByTestId(`artifact-menu-${OWNED_ID}`);
  await expect(menu).toBeVisible();

  const dialog = new Promise<void>((resolve) => {
    page.once("dialog", async (event) => {
      await event.accept();
      resolve();
    });
  });
  await menu.getByTestId(`artifact-delete-${OWNED_ID}`).click();
  await dialog;

  await expect(row).toHaveCount(0);
});
