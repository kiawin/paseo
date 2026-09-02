import { expect, test } from "../../app/e2e/support/fixtures";
import { openSettings } from "../../app/e2e/support/helpers/app";
import { openSettingsSection } from "../../app/e2e/support/helpers/settings";
import { openAgentRoute, seedMockAgentWorkspace } from "../../app/e2e/support/helpers/mock-agent";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { installDesktopRuntime } from "./support/runtime";

const LINK_URL = "https://example.com/release-notes";
const ASSISTANT_MARKDOWN =
  "Release notes are at [the release notes](https://example.com/release-notes) if you want them.";

/**
 * The desktop-only half of agent link routing. `Open in Paseo browser` and the
 * `Agent links` setting are both gated on the Electron runtime, so they only exist
 * behind the injected desktop bridge this project installs.
 */

/**
 * `installDesktopRuntime` stops at the daemon and update IPC. Opening a browser tab reaches
 * the Electron pane, which refuses to attach without a persistent profile partition, so the
 * bridge needs that much of the real preload to exist.
 */
async function installBrowserProfileBridge(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const host = (window as unknown as { paseoDesktop?: Record<string, unknown> }).paseoDesktop;
    if (!host) return;
    host.browser = {
      profilePartition: "persist:paseo-e2e-browser",
      registerAttachedBrowser: async () => undefined,
    };
  });
}

/** A workspace browser tab's deterministic test id (see workspace-tabs/identity.ts). */
const BROWSER_TAB = '[data-testid^="workspace-tab-browser_"]';

/** The setting is client-local, so persistence is observable in the renderer's storage. */
async function readStoredAgentLinkBehavior(
  page: import("@playwright/test").Page,
): Promise<unknown> {
  const raw = await page.evaluate(() => localStorage.getItem("@paseo:app-settings"));
  return raw ? (JSON.parse(raw) as { agentLinkBehavior?: unknown }).agentLinkBehavior : null;
}

test.describe("Agent link routing on desktop", () => {
  test("offers the in-app destination and opens a workspace browser tab", async ({ page }) => {
    await installDesktopRuntime(page, { serverId: getServerId() });
    await installBrowserProfileBridge(page);

    const agent = await seedMockAgentWorkspace({
      repoPrefix: "agent-link-desktop-menu-",
      title: "Agent link desktop menu",
      initialPrompt: "Render the link fixture.",
      featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
    });

    try {
      await agent.client.waitForAgentUpsert(agent.agentId, (s) => s.status === "idle", 30_000);
      await openAgentRoute(page, agent);

      const link = page
        .getByTestId("assistant-message")
        .filter({ hasText: "Release notes are at" })
        .locator(`a[href="${LINK_URL}"]`);
      await expect(link).toBeVisible();
      await link.click({ button: "right" });

      // The Electron-only row is present here and absent on browser web.
      const openInPaseo = page.getByTestId("assistant-link-open-in-paseo");
      await expect(openInPaseo).toBeVisible();
      await expect(page.getByTestId("assistant-link-open-in-browser")).toBeVisible();
      await expect(page.getByTestId("assistant-link-copy")).toBeVisible();

      await openInPaseo.click();

      // A workspace browser tab now exists for the link's URL.
      await expect(page.locator(BROWSER_TAB)).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await agent.cleanup();
    }
  });

  test("routes plain taps in-app once the Agent links setting is switched", async ({ page }) => {
    await installDesktopRuntime(page, { serverId: getServerId() });
    await installBrowserProfileBridge(page);

    const agent = await seedMockAgentWorkspace({
      repoPrefix: "agent-link-desktop-setting-",
      title: "Agent link desktop setting",
      initialPrompt: "Render the link fixture.",
      featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
    });

    try {
      await agent.client.waitForAgentUpsert(agent.agentId, (s) => s.status === "idle", 30_000);
      await openAgentRoute(page, agent);
      await openSettings(page);
      await openSettingsSection(page, "general");

      await expect(page.getByText("Agent links", { exact: true })).toBeVisible();
      // Default is today's behavior, so nobody's links move on upgrade.
      const trigger = page.getByRole("button", { name: /^Select where agent links open/ });
      await expect(trigger).toHaveAccessibleName(
        "Select where agent links open (External browser)",
      );

      await trigger.click();
      await page.getByRole("menuitem", { name: "In Paseo", exact: true }).click();
      await expect(trigger).toHaveAccessibleName("Select where agent links open (In Paseo)");
      await expect.poll(() => readStoredAgentLinkBehavior(page)).toBe("in-app");

      await openAgentRoute(page, agent);
      const link = page
        .getByTestId("assistant-message")
        .filter({ hasText: "Release notes are at" })
        .locator(`a[href="${LINK_URL}"]`);
      await expect(link).toBeVisible();
      await link.click();

      await expect(page.locator(BROWSER_TAB)).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await agent.cleanup();
    }
  });
});
