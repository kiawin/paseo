import { expect, type Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";
import { ensureExplorerSidebar } from "./workspace-tabs";

export async function openNotesPanel(page: Page): Promise<void> {
  const explorer = await ensureExplorerSidebar(page);
  const notesTab = explorer.getByTestId("workspace-tab-notes").first();
  if ((await notesTab.count()) > 0) {
    await notesTab.click();
    return;
  }

  await explorer.getByRole("button", { name: "New tab", exact: true }).click();
  const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await expect(menu).toHaveCSS("opacity", "1");
  await menu.getByRole("menuitem", { name: /^Notes/ }).click();
  await expect(menu).not.toBeVisible();
}

/**
 * Passes every message through to the real daemon except the first `note.search.request` and the
 * first `note.pin.set.request`, which are answered with a failure — the daemon never sees them.
 */
export async function failFirstNoteSearchAndPin(page: Page): Promise<void> {
  let failSearch = true;
  let failPin = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      if (typeof message !== "string") {
        serverSocket.send(message);
        return;
      }
      const inbound = (
        JSON.parse(message) as {
          message?: { type?: string; projectId?: string; requestId?: string };
        }
      ).message;
      if (failSearch && inbound?.type === "note.search.request") {
        failSearch = false;
        browserSocket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "note.search.response",
              payload: {
                projectId: inbound.projectId,
                matches: [],
                success: false,
                error: "search unavailable",
                requestId: inbound.requestId,
              },
            },
          }),
        );
        return;
      }
      if (failPin && inbound?.type === "note.pin.set.request") {
        failPin = false;
        browserSocket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "note.pin.set.response",
              payload: {
                note: null,
                success: false,
                error: "pin unavailable",
                requestId: inbound.requestId,
              },
            },
          }),
        );
        return;
      }
      serverSocket.send(message);
    });
  });
}
