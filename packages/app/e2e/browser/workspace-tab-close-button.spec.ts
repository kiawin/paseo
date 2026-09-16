import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { openSettings } from "../support/helpers/app";
import { openSettingsSection } from "../support/helpers/settings";
import {
  createMockIdleAgent,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openWorkspaceWithAgents,
} from "../support/helpers/archive-tab";

const CLOSE_BUTTON_SWITCH = "Show close button";

function agentTab(page: Page, agentId: string) {
  return page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first();
}

function agentCloseButton(page: Page, agentId: string) {
  return page.getByTestId(`workspace-agent-close-${agentId}`).filter({ visible: true });
}

async function setShowCloseButton(page: Page, enabled: boolean): Promise<void> {
  const workspaceUrl = page.url();
  await openSettings(page);
  await openSettingsSection(page, "appearance");
  const toggle = page.getByRole("switch", { name: CLOSE_BUTTON_SWITCH, exact: true });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if (enabled) {
    await expect(toggle).not.toBeChecked();
  } else {
    await expect(toggle).toBeChecked();
  }
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: enabled });
  await page.goto(workspaceUrl);
}

test.describe("Workspace tab close button", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;
  let workspaceId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("tab-close-button-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    workspaceId = created.workspace.id;
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  async function seedTwoAgents() {
    const first = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `tab-close-a-${randomUUID().slice(0, 8)}`,
    });
    const second = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `tab-close-b-${randomUUID().slice(0, 8)}`,
    });
    return [first, second] as const;
  }

  test("hovering a tab reveals the close button by default", async ({ page }) => {
    const [first, second] = await seedTwoAgents();
    await openWorkspaceWithAgents(page, [first, second]);

    await agentTab(page, first.id).hover();
    await expect(agentCloseButton(page, first.id).first()).toBeVisible({ timeout: 30_000 });

    await agentCloseButton(page, first.id).first().click();
    await expectWorkspaceTabHidden(page, first.id);
    await expectWorkspaceTabVisible(page, second.id);
  });

  test("turning the setting off hides the close button and leaves Close in the tab menu", async ({
    page,
  }) => {
    const [first, second] = await seedTwoAgents();
    await openWorkspaceWithAgents(page, [first, second]);
    await setShowCloseButton(page, false);

    await expectWorkspaceTabVisible(page, first.id);
    await agentTab(page, first.id).hover();
    await expect(agentCloseButton(page, first.id)).toHaveCount(0);

    await agentTab(page, first.id).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expectWorkspaceTabHidden(page, first.id);
    await expectWorkspaceTabVisible(page, second.id);
  });
});
