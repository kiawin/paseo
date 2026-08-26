import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

/**
 * A workspace row draws an agent sub-list only when it holds more than one active root agent.
 * These cover the geometry that reading the styles cannot settle: the disclosure sits next to the
 * trailing slot, and the kebab overlays that slot on hover with a scrim sized to hide what is
 * behind it.
 */

const AGENT_TITLES = ["Rebase onto upstream main", "Port sidebar agent rows", "Audit COMPAT tags"];

function rowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

test.describe("sidebar agent rows", () => {
  test("shows a count, expands, and keeps the kebab readable on hover", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "paseo-e2e-agent-rows-" });
    try {
      for (const title of AGENT_TITLES) {
        await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title,
          modeId: "load-test",
          model: "e2e-fast-stream",
        });
      }

      await gotoAppShell(page);

      const row = page.getByTestId(rowTestId(workspace.workspaceId));
      await expect(row).toBeVisible({ timeout: 30_000 });

      const disclosure = page.getByTestId("sidebar-agent-list-disclosure");
      await expect(disclosure).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("sidebar-workspace-agent-count")).toContainText(
        String(AGENT_TITLES.length),
      );

      // Collapsed by default: the count is there, the rows are not.
      await expect(page.getByTestId("sidebar-agent-list")).toHaveCount(0);

      await page.screenshot({ path: "test-results/agent-rows-collapsed-idle.png" });

      // Hover is where the kebab fades in over the trailing slot. The count must stay legible.
      //
      // `toBeVisible` is not enough here: the kebab is an absolutely positioned overlay, so it
      // paints over the count without changing its computed visibility. Compare boxes instead.
      await row.hover();
      await expect(disclosure).toBeVisible();
      await page.screenshot({ path: "test-results/agent-rows-collapsed-hover.png" });

      const kebab = page.getByTestId(
        `sidebar-workspace-kebab-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(kebab).toBeVisible({ timeout: 10_000 });
      const countBox = await disclosure.boundingBox();
      const kebabBox = await kebab.boundingBox();
      expect(countBox).not.toBeNull();
      expect(kebabBox).not.toBeNull();
      if (countBox && kebabBox) {
        const overlap =
          Math.min(countBox.x + countBox.width, kebabBox.x + kebabBox.width) -
          Math.max(countBox.x, kebabBox.x);
        expect(overlap, `count overlapped by the kebab by ${overlap}px`).toBeLessThanOrEqual(0);
      }

      await disclosure.click();
      const list = page.getByTestId("sidebar-agent-list");
      await expect(list).toBeVisible({ timeout: 10_000 });
      for (const title of AGENT_TITLES) {
        await expect(list.getByText(title, { exact: true })).toBeVisible();
      }

      // The sub-list hangs off the count, so its dots share a left rail with that digit. Without
      // it the rows read as a second, unrelated column.
      const railBox = await page.getByTestId("sidebar-workspace-agent-count").boundingBox();
      const firstDotBox = await list
        .getByTestId(/^sidebar-agent-row-dot-/)
        .first()
        .boundingBox();
      expect(railBox).not.toBeNull();
      expect(firstDotBox).not.toBeNull();
      if (railBox && firstDotBox) {
        const drift = Math.abs(firstDotBox.x - railBox.x);
        expect(
          drift,
          `agent dots drift ${drift}px from the count rail (dot x=${firstDotBox.x}, count x=${railBox.x})`,
        ).toBeLessThanOrEqual(1);
      }

      await row.hover();
      await page.screenshot({ path: "test-results/agent-rows-expanded-hover.png" });
    } finally {
      await workspace.cleanup();
    }
  });

  test("draws nothing for a workspace holding one agent", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "paseo-e2e-agent-rows-single-" });
    try {
      await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Only agent",
        modeId: "load-test",
        model: "e2e-fast-stream",
      });

      await gotoAppShell(page);
      await expect(page.getByTestId(rowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("sidebar-agent-list-disclosure")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});
