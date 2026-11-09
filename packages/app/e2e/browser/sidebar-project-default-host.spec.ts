import path from "node:path";

import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addConnectedHostAndReload,
  reloadPreservingHostRegistry,
  waitForConnectedHost,
} from "../support/helpers/hosts";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { connectSeedClient, type SeedDaemonClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { createTempGitRepo } from "../support/helpers/workspace";

/**
 * Choosing which host a project's new workspaces start on, from the project menu.
 *
 * Also writes QA evidence per docs/qa.md: screenshots land flat in `qa-evidence/` at the
 * repository root, which is gitignored, so they are attached to the pull request.
 */
const EVIDENCE_DIR = path.resolve(__dirname, "../../../..", "qa-evidence");
const SHARED_REMOTE_URL = "https://github.com/paseo-e2e/default-host-project.git";
const PRIMARY_LABEL = "Primary Host";
const SECONDARY_LABEL = "Secondary Host";

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), animations: "allow" });
}

async function createProject(client: SeedDaemonClient, projectPath: string) {
  const created = await client.createWorkspace({
    source: { kind: "directory", path: projectPath },
    title: "Default host workspace",
  });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create project");
  const listed = await client.listProjects();
  const descriptor = listed.projects.find(
    (item) => item.projectId === created.workspace?.projectId,
  );
  if (!descriptor?.projectKey) throw new Error("Created project has no project key");
  return { projectId: created.workspace.projectId, projectKey: descriptor.projectKey };
}

test.describe("Project default host", () => {
  test.describe.configure({ timeout: 180_000 });

  let secondaryHost: IsolatedHostDaemon;

  test.beforeAll(async () => {
    secondaryHost = await startIsolatedHostDaemon("default-host-secondary");
  });

  test.afterAll(async () => {
    await secondaryHost?.close();
  });

  test("new workspace starts on the chosen default host and returns to automatic when cleared", async ({
    page,
  }) => {
    const primaryRepo = await createTempGitRepo("default-host-primary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const secondaryRepo = await createTempGitRepo("default-host-secondary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const primaryClient = await connectSeedClient();
    const secondaryClient = await connectSeedClient({ port: secondaryHost.port });
    const primary = await createProject(primaryClient, primaryRepo.path);
    const secondary = await createProject(secondaryClient, secondaryRepo.path);
    const primaryServerId = getServerId();
    const key = primary.projectKey;
    expect(secondary.projectKey).toBe(key);

    try {
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryHost.serverId,
        label: SECONDARY_LABEL,
        port: secondaryHost.port,
        primaryLabel: PRIMARY_LABEL,
      });
      await waitForConnectedHost(page, {
        serverId: secondaryHost.serverId,
        endpoint: `localhost:${secondaryHost.port}`,
      });
      await waitForSidebarHydration(page);

      const row = page.getByTestId(`sidebar-project-row-${key}`);
      const primaryItem = page.getByTestId(
        `sidebar-project-menu-default-host-${primaryServerId}-${key}`,
      );
      const secondaryItem = page.getByTestId(
        `sidebar-project-menu-default-host-${secondaryHost.serverId}-${key}`,
      );
      const openMenu = async () => {
        await row.hover();
        await page.getByTestId(`sidebar-project-kebab-${key}`).click();
      };
      const beginWorkspace = async () => {
        await row.hover();
        await page.getByTestId(`sidebar-project-new-worktree-${key}`).click();
      };

      await expect(row).toBeVisible({ timeout: 30_000 });
      await openMenu();
      await expect(primaryItem).toHaveText(`Default: ${PRIMARY_LABEL}`);
      await expect(secondaryItem).toHaveText(`Default: ${SECONDARY_LABEL}`);
      await expect(primaryItem).not.toHaveAttribute("aria-checked", "true");
      await expect(secondaryItem).not.toHaveAttribute("aria-checked", "true");
      await shot(page, "default-host-01-menu-none-chosen");

      await secondaryItem.click();
      await openMenu();
      await expect(secondaryItem).toHaveAttribute("aria-checked", "true");
      await shot(page, "default-host-02-menu-secondary-chosen");
      await page.keyboard.press("Escape");

      await beginWorkspace();
      await expect(page).toHaveURL(new RegExp(secondaryHost.serverId), { timeout: 30_000 });
      await shot(page, "default-host-03-new-workspace-on-secondary");

      // The choice is stored by the app, so it survives a reload.
      await reloadPreservingHostRegistry(page);
      await waitForSidebarHydration(page);
      await openMenu();
      await expect(secondaryItem).toHaveAttribute("aria-checked", "true");
      await secondaryItem.click();

      await openMenu();
      await expect(secondaryItem).not.toHaveAttribute("aria-checked", "true");
      await shot(page, "default-host-04-menu-cleared");
      await page.keyboard.press("Escape");

      await beginWorkspace();
      await expect(page).toHaveURL(new RegExp(primaryServerId), { timeout: 30_000 });
      await shot(page, "default-host-05-new-workspace-automatic");
    } finally {
      await primaryClient.removeProject(primary.projectId).catch(() => undefined);
      await secondaryClient.removeProject(secondary.projectId).catch(() => undefined);
      await primaryClient.close().catch(() => undefined);
      await secondaryClient.close().catch(() => undefined);
      await primaryRepo.cleanup().catch(() => undefined);
      await secondaryRepo.cleanup().catch(() => undefined);
    }
  });
});
