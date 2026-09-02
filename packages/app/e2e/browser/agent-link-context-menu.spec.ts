import type { BrowserContext } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const LINK_URL = "https://example.com/release-notes";

const ASSISTANT_MARKDOWN = [
  "Release notes are at [the release notes](https://example.com/release-notes) if you want them.",
  "",
  "The second paragraph exists so a reflow above it is measurable.",
].join("\n");

async function allowClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
}

/**
 * Records `window.open` instead of letting it fire, so a plain click's destination is
 * observable. The browser build of `openExternalUrl` has no desktop opener and falls
 * through to `window.open`.
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

test("right-clicking an agent link offers its destinations without disturbing the paragraph", async ({
  context,
  page,
}) => {
  await allowClipboard(context);
  await recordWindowOpen(page);

  const agent = await seedMockAgentWorkspace({
    repoPrefix: "agent-link-context-menu-",
    title: "Agent link context menu",
    initialPrompt: "Render the link fixture.",
    featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
  });

  try {
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await openAgentRoute(page, agent);

    const assistantMessage = page
      .getByTestId("assistant-message")
      .filter({ hasText: "Release notes are at" });
    const link = assistantMessage.locator(`a[href="${LINK_URL}"]`);
    await expect(link).toBeVisible();

    // The link must stay inline. `display: contents` is what keeps it there: the anchor
    // generates no box of its own, so the gesture handler on it cannot promote the span
    // into a block and rewrap the sentence.
    await expect(link).toHaveCSS("display", "contents");
    const paragraphBefore = await assistantMessage.boundingBox();
    expect(paragraphBefore).not.toBeNull();

    await link.click({ button: "right" });

    const menu = page.getByTestId("assistant-link-context-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("assistant-link-open-in-browser")).toBeVisible();
    await expect(page.getByTestId("assistant-link-copy")).toBeVisible();
    // Browser web is not Electron, so there is no in-app destination to offer.
    await expect(page.getByTestId("assistant-link-open-in-paseo")).toHaveCount(0);

    // Opening the menu must not move the message it was opened from.
    const paragraphDuring = await assistantMessage.boundingBox();
    expect(paragraphDuring).toEqual(paragraphBefore);

    await page.getByTestId("assistant-link-copy").click();
    await expect(menu).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(LINK_URL);

    // The menu is a chooser, not an opener: copying must not have navigated anywhere.
    expect(await readOpenedUrls(page)).toEqual([]);

    const paragraphAfter = await assistantMessage.boundingBox();
    expect(paragraphAfter).toEqual(paragraphBefore);

    // Regression: a plain click still goes to the system browser, the default behavior.
    await link.click();
    await expect.poll(() => readOpenedUrls(page)).toEqual([LINK_URL]);
  } finally {
    await agent.cleanup();
  }
});

test("Open in browser sends the link to the system browser", async ({ page }) => {
  await recordWindowOpen(page);

  const agent = await seedMockAgentWorkspace({
    repoPrefix: "agent-link-context-menu-external-",
    title: "Agent link context menu external",
    initialPrompt: "Render the link fixture.",
    featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
  });

  try {
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await openAgentRoute(page, agent);

    const link = page
      .getByTestId("assistant-message")
      .filter({ hasText: "Release notes are at" })
      .locator(`a[href="${LINK_URL}"]`);
    await link.click({ button: "right" });
    await page.getByTestId("assistant-link-open-in-browser").click();

    await expect.poll(() => readOpenedUrls(page)).toEqual([LINK_URL]);
  } finally {
    await agent.cleanup();
  }
});
