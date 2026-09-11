import { expect, test as baseTest } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openSettingsSection } from "../support/helpers/settings";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerEditable,
} from "../support/helpers/composer";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

const test = baseTest.extend<{ agent: MockAgentWorkspace }>({
  agent: async ({ page: _page }, provide) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-send-key-",
      title: "Composer send key",
    });
    await provide(agent);
    await agent.cleanup();
  },
});

async function chooseSendKey(page: import("@playwright/test").Page, label: string): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "general");

  const row = page.getByText("Send message with", { exact: true }).first();
  await expect(row).toBeVisible();

  await page.getByRole("button", { name: /^Send message with: / }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(page.getByRole("button", { name: `Send message with: ${label}` })).toBeVisible();
}

test("Enter sends and Shift+Enter breaks the line by default", async ({ page, agent }) => {
  await openAgentRoute(page, agent);
  await expectComposerEditable(page);

  const composer = composerLocator(page);
  await composer.fill("first line");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("second line");
  await expectComposerDraft(page, "first line\nsecond line");

  await composer.press("Enter");
  await expectComposerDraft(page, "");
  await expect(page.getByTestId("user-message").filter({ hasText: "second line" })).toBeVisible({
    timeout: 30_000,
  });
});

test("Shift+Enter sends and Enter breaks the line once the setting is switched", async ({
  page,
  agent,
}) => {
  await chooseSendKey(page, "Shift+Enter");

  await openAgentRoute(page, agent);
  await expectComposerEditable(page);

  const composer = composerLocator(page);
  await composer.fill("first line");
  await composer.press("Enter");
  await composer.pressSequentially("second line");
  await expectComposerDraft(page, "first line\nsecond line");
  await expect(page.getByTestId("user-message")).toHaveCount(0);

  await composer.press("Shift+Enter");
  await expectComposerDraft(page, "");
  await expect(page.getByTestId("user-message").filter({ hasText: "second line" })).toBeVisible({
    timeout: 30_000,
  });
});
