import path from "node:path";

import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openProjects } from "../support/helpers/project-settings";
import { openSidebarDisplayPage } from "../support/helpers/sidebar";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

/**
 * Hiding a project from the sidebar and showing it again from Settings → Projects.
 *
 * Also writes QA evidence per docs/qa.md: screenshots land flat in `qa-evidence/` at the
 * repository root, which is gitignored, so they are attached to the pull request.
 */
const EVIDENCE_DIR = path.resolve(__dirname, "../../../..", "qa-evidence");

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), animations: "allow" });
}

test("hides a project from the sidebar and shows it again from settings", async ({ page }) => {
  const shown = await seedWorkspace({ repoPrefix: "hide-project-shown-" });
  const hidden = await seedWorkspace({ repoPrefix: "hide-project-bot-" });
  const shownKey = projectEquivalenceViewKey(shown.projectKey);
  const hiddenKey = projectEquivalenceViewKey(hidden.projectKey);

  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const hiddenRow = page.getByTestId(`sidebar-project-row-${hiddenKey}`);
    await expect(hiddenRow).toBeVisible({ timeout: 30_000 });

    await hiddenRow.hover();
    await page.getByTestId(`sidebar-project-kebab-${hiddenKey}`).click();
    const hideItem = page.getByTestId(`sidebar-project-menu-hide-${hiddenKey}`);
    await expect(hideItem).toHaveText("Hide from sidebar");
    await shot(page, "hide-project-01-menu");

    await hideItem.click();
    await expect(hiddenRow).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId(`sidebar-project-row-${shownKey}`)).toBeVisible();
    await shot(page, "hide-project-02-sidebar-after-hide");

    await openProjects(page);
    const hiddenSection = page.getByTestId("projects-hidden");
    await expect(hiddenSection).toContainText("Hidden from sidebar");
    await expect(hiddenSection).toContainText(hidden.projectDisplayName);
    await expect(hiddenSection).not.toContainText(shown.projectDisplayName);
    await shot(page, "hide-project-03-settings-hidden-section");

    await page.getByTestId(`project-show-${hiddenKey}`).click();
    await expect(hiddenSection).toHaveCount(0, { timeout: 30_000 });
    await shot(page, "hide-project-04-settings-after-show");

    await gotoAppShell(page);
    await expect(page.getByTestId(`sidebar-project-row-${hiddenKey}`)).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await hidden.cleanup();
    await shown.cleanup();
  }
});

test("lists hidden projects with Show hidden on and shows one again from its menu", async ({
  page,
}) => {
  const shown = await seedWorkspace({ repoPrefix: "hide-project-shown-" });
  const hidden = await seedWorkspace({ repoPrefix: "hide-project-bot-" });
  const hiddenKey = projectEquivalenceViewKey(hidden.projectKey);
  await hidden.client.setProjectHidden(hidden.projectId, true);

  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const hiddenRow = page.getByTestId(`sidebar-project-row-${hiddenKey}`);
    await expect(hiddenRow).toHaveCount(0, { timeout: 30_000 });

    await openSidebarDisplayPage(page, "sidebar-display-show-hidden");
    await expect(page.getByTestId("sidebar-display-show-hidden")).toBeVisible();
    await shot(page, "hide-project-05-show-hidden-toggle");
    await page.keyboard.press("Escape");

    await expect(hiddenRow).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`sidebar-project-hidden-mark-${hiddenKey}`)).toBeVisible();
    await hiddenRow.hover();
    await page.getByTestId(`sidebar-project-kebab-${hiddenKey}`).click();
    const showItem = page.getByTestId(`sidebar-project-menu-show-${hiddenKey}`);
    await expect(showItem).toHaveText("Show in sidebar");
    await shot(page, "hide-project-06-hidden-row-menu");

    await showItem.click();
    await expect(page.getByTestId(`sidebar-project-hidden-mark-${hiddenKey}`)).toHaveCount(0, {
      timeout: 30_000,
    });

    // Turning the toggle back off keeps the project, since it is no longer hidden.
    await openSidebarDisplayPage(page, "sidebar-display-show-hidden");
    await page.keyboard.press("Escape");
    await expect(hiddenRow).toBeVisible();
    await shot(page, "hide-project-07-shown-again");
  } finally {
    await hidden.cleanup();
    await shown.cleanup();
  }
});
