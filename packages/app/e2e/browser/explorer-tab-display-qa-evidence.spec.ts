import path from "node:path";

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openSettings } from "../support/helpers/app";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openSettingsSection } from "../support/helpers/settings";
import {
  ensureExplorerSidebar,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

/**
 * Captures the Explorer tabs appearance setting as QA evidence, per docs/qa.md.
 *
 * Files land in `qa-evidence/` at the repository root, flat and stably named, so a rerun
 * overwrites the previous set. The directory is gitignored.
 */
const EVIDENCE_DIR = path.resolve(__dirname, "../../../..", "qa-evidence");

const SELECT_LABEL = "Explorer tabs";

async function shot(target: Page | Locator, name: string): Promise<void> {
  const page = "page" in target ? target.page() : target;
  await page.waitForTimeout(400);
  await target.screenshot({
    path: path.join(EVIDENCE_DIR, `explorer-tab-display-${name}.png`),
    animations: "allow",
  });
}

function displaySelect(page: Page) {
  return page.getByRole("button", { name: new RegExp(`^${SELECT_LABEL}: `) });
}

async function chooseDisplay(page: Page, option: string): Promise<void> {
  const workspaceUrl = page.url();
  await openSettings(page);
  await openSettingsSection(page, "appearance");
  await displaySelect(page).click();
  await page.getByRole("menuitem", { name: option, exact: true }).click();
  await expect(displaySelect(page)).toHaveAccessibleName(`${SELECT_LABEL}: ${option}`);
  await page.goto(workspaceUrl);
}

async function chipWidth(chip: Locator): Promise<number> {
  const box = await chip.boundingBox();
  if (!box) throw new Error("Explorer tab chip has no layout box");
  return box.width;
}

test("evidence: Explorer tabs show icon and name, icon only, or name only", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-tab-display-evidence-" });

  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);

    // Measured on Changes: a short label like Files sits under the minimum chip width either way.
    const widths: Record<string, number> = {};

    await test.step("the default shows icon and name", async () => {
      const explorer = await ensureExplorerSidebar(page);
      const files = explorer.getByTestId("workspace-tab-files");
      await expect(files.getByText("Files", { exact: true })).toBeVisible();
      await expect(
        explorer.getByTestId("workspace-tab-changes_tree").getByText("Changes", { exact: true }),
      ).toBeVisible();
      widths.iconAndName = await chipWidth(explorer.getByTestId("workspace-tab-changes_tree"));
      await shot(explorer, "01-icon-and-name");
    });

    await test.step("the setting offers three choices", async () => {
      const workspaceUrl = page.url();
      await openSettings(page);
      await openSettingsSection(page, "appearance");
      await expect(displaySelect(page)).toHaveAccessibleName(`${SELECT_LABEL}: Icon and name`);
      await displaySelect(page).click();
      for (const option of ["Icon and name", "Icon only", "Name only"]) {
        await expect(page.getByRole("menuitem", { name: option, exact: true })).toBeVisible();
      }
      await shot(page, "02-setting-options");
      await page.keyboard.press("Escape");
      await page.goto(workspaceUrl);
    });

    await test.step("icon only hides the names and narrows the chips", async () => {
      await chooseDisplay(page, "Icon only");
      const explorer = await ensureExplorerSidebar(page);
      const files = explorer.getByTestId("workspace-tab-files");
      await expect(files).toBeVisible({ timeout: 30_000 });
      await expect(files.getByText("Files", { exact: true })).toHaveCount(0);
      await expect(files).toHaveAccessibleName(/./);
      widths.icon = await chipWidth(explorer.getByTestId("workspace-tab-changes_tree"));
      await shot(explorer, "03-icon-only");
    });

    await test.step("name only shows the names without icons", async () => {
      await chooseDisplay(page, "Name only");
      const explorer = await ensureExplorerSidebar(page);
      const files = explorer.getByTestId("workspace-tab-files");
      await expect(files.getByText("Files", { exact: true })).toBeVisible({ timeout: 30_000 });
      widths.name = await chipWidth(explorer.getByTestId("workspace-tab-changes_tree"));
      await shot(explorer, "04-name-only");
    });

    await test.step("main pane tabs keep icon and name", async () => {
      await shot(page, "05-full-workspace-name-only");
    });

    expect(widths.icon).toBeLessThan(widths.name);
    expect(widths.name).toBeLessThan(widths.iconAndName);
  } finally {
    await workspace.cleanup();
  }
});
