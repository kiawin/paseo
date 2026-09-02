import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  STUB_PR_NUMBER,
  STUB_PR_TITLE,
  STUB_PR_URL,
  stubOpenPullRequest,
} from "../support/helpers/pr-status-stub";
import { openChangesPanel, openPullRequestPanel } from "../support/helpers/workspace-tabs";

/**
 * Browser web is the platform where the pull request links setting cannot apply: an in-app
 * destination is a browser tab inside an Electron workspace, so there is nothing for the
 * preference to point at here.
 *
 * That makes two things worth proving on web, both of which this spec asserts before it
 * screenshots anything. First, every forge link still reaches the system browser, which is the
 * regression the new indirection could cause — the links now go through `ForgeLinkProvider`
 * instead of calling `openExternalUrl` at the press handler. Second, the new Open location row
 * stays off web entirely, rather than offering a destination the platform cannot honor.
 *
 * Files land in `qa-evidence/` at the repository root, flat and stably named, so a rerun
 * overwrites the previous set and the names can be quoted in a pull request. The directory is
 * gitignored — screenshots are attached to the pull request, not committed.
 */
const EVIDENCE_DIR = path.resolve(__dirname, "../../../..", "qa-evidence");

const FORGE_LINK_ROW_LABEL = "Clicking a pull request or check link";

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, `${name}.png`),
    fullPage: true,
    animations: "allow",
  });
}

/**
 * Records `window.open` instead of letting it fire, so each link's destination is observable.
 * The browser build of `openExternalUrl` has no desktop opener and falls through to
 * `window.open`.
 */
async function recordWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const opened: string[] = [];
    Object.defineProperty(window, "__paseoOpenedUrls", { value: opened, writable: false });
    window.open = ((url?: string | URL) => {
      opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });
}

async function readOpenedUrls(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __paseoOpenedUrls: string[] }).__paseoOpenedUrls,
  );
}

test("forge links on web reach the system browser from every surface that renders one", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await recordWindowOpen(page);
  await stubOpenPullRequest(page);

  const agent = await seedMockAgentWorkspace({
    repoPrefix: "forge-link-destination-",
    title: "Forge link destination",
    initialPrompt: "Seed the workspace.",
  });

  try {
    // The Changes pane opens on a changed file, and the seeded repo commits everything it
    // writes, so the working tree needs one edit before the toolbar exists to click.
    await writeFile(path.join(agent.cwd, "uncommitted.txt"), "forge link evidence\n");
    await openAgentRoute(page, agent);

    // The Changes toolbar's forge link: the model comes from the stubbed PR status.
    await openChangesPanel(page);
    const changesExternalLink = page
      .locator('[data-testid="changes-open-pull-request-external"]:visible')
      .first();
    await expect(changesExternalLink).toBeVisible({ timeout: 30_000 });
    await shot(page, "forge-link-web-changes-toolbar");

    await changesExternalLink.click();
    await expect.poll(() => readOpenedUrls(page)).toEqual([STUB_PR_URL]);

    // The PR pane header, which is the surface the setting is mainly about on desktop.
    await openPullRequestPanel(page);
    const paneTitle = page.locator('[data-testid="pr-pane-title"]:visible').first();
    await expect(paneTitle).toContainText(STUB_PR_TITLE, { timeout: 30_000 });
    await expect(paneTitle).toContainText(`#${STUB_PR_NUMBER}`);
    await shot(page, "forge-link-web-pr-pane");

    await page.locator('[data-testid="pr-pane-view-pr"]:visible').first().click();
    await expect.poll(() => readOpenedUrls(page)).toEqual([STUB_PR_URL, STUB_PR_URL]);

    // Clicking the title opens the same destination as the toolbar button beside it.
    await paneTitle.click();
    await expect.poll(() => readOpenedUrls(page)).toEqual([STUB_PR_URL, STUB_PR_URL, STUB_PR_URL]);
  } finally {
    await agent.cleanup();
  }
});

test("web does not offer the pull request links destination it cannot honor", async ({ page }) => {
  await gotoAppShell(page);
  await openSettings(page);

  // Open location is desktop-only: its destinations are panes and browser tabs inside an
  // Electron window. The whole section is absent here, the new row with it.
  await expect(page.getByText("Open location", { exact: true })).toHaveCount(0);
  await expect(page.getByText(FORGE_LINK_ROW_LABEL, { exact: true })).toHaveCount(0);
  await shot(page, "forge-link-web-settings-general");
});
