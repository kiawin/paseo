import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { buildPullRequestsRoute } from "../../src/utils/host-routes";

// The fixture daemon's workspaces have no forge remote, so none carries a pull request.
// Rows, sections, and the auto-fix switch are covered by pull-request-rows.test.ts.
test.describe("Pull requests screen", () => {
  test("opens from the sidebar and shows the empty state", async ({ page }) => {
    await gotoAppShell(page);

    const sidebarRow = page.locator('[data-testid="sidebar-pull-requests"]:visible').first();
    await expect(sidebarRow).toBeVisible({ timeout: 30_000 });
    await sidebarRow.click();

    await expectAppRoute(page, buildPullRequestsRoute(), { timeout: 30_000 });
    const empty = page.getByTestId("pull-requests-empty");
    await expect(empty).toBeVisible({ timeout: 30_000 });
    await expect(empty).toHaveText("No open pull requests");
  });
});
