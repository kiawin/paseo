import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

/**
 * Capture-only. Produces the PR evidence for the sidebar agent sub-list into
 * `test-results/evidence/`, at 3x so the crops stay readable when scaled down in a PR body.
 *
 * Opt-in because it exists to write files, not to assert: the behaviour it photographs is
 * covered by `sidebar-agent-rows.spec.ts`, which runs on every push. Same shape as the
 * `PASEO_DIFF_PERF_E2E` capture spec.
 *
 *   PASEO_SIDEBAR_EVIDENCE=1 npx playwright test --project=browser \
 *     e2e/browser/sidebar-agent-rows-evidence.spec.ts
 */

const MULTI_AGENT_TITLES = [
  "Rebase onto upstream main",
  "Port sidebar agent rows",
  "Audit COMPAT tags",
];

/** The sidebar plus a little of the pane behind it, so the row's right edge is in frame. */
const SIDEBAR_CLIP = { x: 0, y: 124, width: 340, height: 292 };

test.describe("sidebar agent rows evidence", () => {
  test.skip(!process.env.PASEO_SIDEBAR_EVIDENCE, "Set PASEO_SIDEBAR_EVIDENCE=1 to capture.");
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 3 });

  test("captures the sub-list states", async ({ page }) => {
    // Two workspaces on purpose: one with several agents and one with a single agent, so every
    // shot also shows what the change does NOT do to an ordinary row.
    const busy = await seedWorkspace({ repoPrefix: "paseo-evidence-busy-" });
    const quiet = await seedWorkspace({ repoPrefix: "paseo-evidence-quiet-" });
    try {
      for (const title of MULTI_AGENT_TITLES) {
        await busy.client.createAgent({
          provider: "mock",
          cwd: busy.repoPath,
          workspaceId: busy.workspaceId,
          title,
          modeId: "load-test",
          model: "e2e-fast-stream",
        });
      }
      await quiet.client.createAgent({
        provider: "mock",
        cwd: quiet.repoPath,
        workspaceId: quiet.workspaceId,
        title: "Only agent here",
        modeId: "load-test",
        model: "e2e-fast-stream",
      });

      await gotoAppShell(page);

      const busyRow = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${busy.workspaceId}`,
      );
      await expect(busyRow).toBeVisible({ timeout: 30_000 });
      const disclosure = page.getByTestId("sidebar-agent-list-disclosure");
      await expect(disclosure).toBeVisible({ timeout: 30_000 });

      // 1. Resting state. The busy workspace carries a count; the quiet one is untouched.
      await page.screenshot({
        path: "test-results/evidence/01-collapsed.png",
        clip: SIDEBAR_CLIP,
      });

      // 2. Hovered. The kebab is what used to paint over the count.
      await busyRow.hover();
      await expect(disclosure).toBeVisible();
      await page.screenshot({
        path: "test-results/evidence/02-hover-with-kebab.png",
        clip: SIDEBAR_CLIP,
      });

      // 3. Expanded: provider icon per row, dots on the count's left rail.
      await disclosure.click();
      const list = page.getByTestId("sidebar-agent-list");
      await expect(list).toBeVisible({ timeout: 10_000 });
      for (const title of MULTI_AGENT_TITLES) {
        await expect(list.getByText(title, { exact: true })).toBeVisible();
      }
      // Park the pointer off the sidebar and let the workspace hover card retract, or it sits
      // over the sub-list in the shot.
      await page.mouse.move(900, 620);
      await expect(page.getByTestId("workspace-hover-card")).toBeHidden({ timeout: 10_000 });
      await page.screenshot({
        path: "test-results/evidence/03-expanded.png",
        clip: SIDEBAR_CLIP,
      });
    } finally {
      await busy.cleanup();
      await quiet.cleanup();
    }
  });
});
