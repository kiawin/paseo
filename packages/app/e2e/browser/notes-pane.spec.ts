import { test, expect } from "../support/fixtures";
import { failFirstNoteSearchAndPin, openNotesPanel } from "../support/helpers/notes";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import type { SeedDaemonClient } from "../support/helpers/seed-client";

async function seedNotes(client: SeedDaemonClient, workspaceId: string) {
  const workspace = (await client.fetchWorkspaces()).entries.find(
    (entry) => entry.id === workspaceId,
  );
  if (!workspace) throw new Error(`Workspace ${workspaceId} is not listed`);
  const projectId = workspace.projectId;
  const save = async (body: string) => (await client.saveNote({ projectId, body })).note.noteId;
  return {
    projectId,
    release: await save("# Release plan\n\nShip on Friday."),
    standup: await save("# Standup\n\nThe launch moved to Monday."),
    retro: await save("# Retro\n\nKeep the demos short."),
  };
}

test("notes can be searched by title and text, and pinned to the top, against the real daemon", async ({
  page,
  withWorkspace,
  e2eWorkerClient,
}) => {
  const workspace = await withWorkspace({ prefix: "notes-search-pin-" });
  const notes = await seedNotes(e2eWorkerClient, workspace.workspaceId);
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openNotesPanel(page);

  const search = page.getByTestId("notes-search").filter({ visible: true }).first();
  const list = page.getByTestId("notes-list").filter({ visible: true }).first();
  await expect(search).toBeVisible({ timeout: 30_000 });
  await expect(search).toHaveAttribute("placeholder", "Search titles and note text");

  await search.fill("  LAUNCH ");
  await expect(list.getByTestId(`note-row-${notes.standup}`)).toBeVisible();
  await expect(list.getByTestId(`note-snippet-${notes.standup}`)).toContainText(
    "The launch moved to Monday.",
  );
  await expect(list.getByTestId(`note-row-${notes.release}`)).toHaveCount(0);
  await expect(list.getByTestId(`note-row-${notes.retro}`)).toHaveCount(0);

  await search.fill("release");
  await expect(list.getByTestId(`note-row-${notes.release}`)).toBeVisible();
  await expect(list.getByTestId(`note-snippet-${notes.release}`)).toHaveCount(0);

  await search.fill("nothing like this");
  await expect(page.getByTestId("notes-no-results").filter({ visible: true })).toContainText(
    "No results found",
  );

  await search.fill("");
  const rows = list.locator('[data-testid^="note-row-"]');
  await expect(rows).toHaveCount(3);
  // Newest first until something is pinned.
  await expect(rows.first()).toHaveAttribute("data-testid", `note-row-${notes.retro}`);

  await list.getByTestId(`note-row-${notes.release}`).click({ button: "right" });
  await page.getByTestId(`note-pin-${notes.release}`).filter({ visible: true }).click();
  await expect(rows.first()).toHaveAttribute("data-testid", `note-row-${notes.release}`);
  await expect(rows.first()).toHaveAccessibleName("Release plan, Pinned");
  await expect
    .poll(async () =>
      (await e2eWorkerClient.listNotes(notes.projectId)).map((note) => [
        note.displayTitle,
        note.pinned === true,
      ]),
    )
    .toEqual([
      ["Release plan", true],
      ["Retro", false],
      ["Standup", false],
    ]);

  await list.getByTestId(`note-row-${notes.release}`).click({ button: "right" });
  await page.getByTestId(`note-pin-${notes.release}`).filter({ visible: true }).click();
  await expect(rows.first()).toHaveAttribute("data-testid", `note-row-${notes.retro}`);
});

test("a failed note search falls back to titles and can be retried; a failed pin says so", async ({
  page,
  withWorkspace,
  e2eWorkerClient,
}) => {
  await failFirstNoteSearchAndPin(page);
  const workspace = await withWorkspace({ prefix: "notes-search-retry-" });
  const notes = await seedNotes(e2eWorkerClient, workspace.workspaceId);
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openNotesPanel(page);
  const search = page.getByTestId("notes-search").filter({ visible: true }).first();
  const list = page.getByTestId("notes-list").filter({ visible: true }).first();
  await search.fill("monday");
  await expect(page.getByTestId("notes-search-error").filter({ visible: true })).toContainText(
    "Could not search note text on every host.",
  );
  // The host's text search failed, so its notes are matched by title alone: nothing is titled
  // "monday".
  await expect(page.getByTestId("notes-no-results").filter({ visible: true })).toBeVisible();

  await page.getByTestId("notes-search-retry").filter({ visible: true }).click();
  await expect(list.getByTestId(`note-snippet-${notes.standup}`)).toContainText("Monday");
  await expect(search).toHaveValue("monday");

  await search.fill("");
  await list.getByTestId(`note-row-${notes.release}`).click({ button: "right" });
  await page.getByTestId(`note-pin-${notes.release}`).filter({ visible: true }).click();
  await expect(page.getByText("Could not update note pin.")).toBeVisible();
  expect(
    (await e2eWorkerClient.listNotes(notes.projectId)).some((note) => note.pinned === true),
  ).toBe(false);
});
