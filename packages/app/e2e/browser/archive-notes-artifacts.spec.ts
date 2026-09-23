import path from "node:path";

import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { openArtifactsPanel } from "../support/helpers/artifacts";
import { openNotesPanel } from "../support/helpers/notes";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import type { SeedDaemonClient } from "../support/helpers/seed-client";

/** Screenshots for the pull request; `qa-evidence/` is gitignored. See docs/qa.md. */
const EVIDENCE_DIR = path.resolve(__dirname, "../../../..", "qa-evidence");

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `archive-${name}.png`) });
}

async function projectIdFor(client: SeedDaemonClient, workspaceId: string): Promise<string> {
  const workspace = (await client.fetchWorkspaces()).entries.find(
    (entry) => entry.id === workspaceId,
  );
  if (!workspace) throw new Error(`Workspace ${workspaceId} is not listed`);
  return workspace.projectId;
}

test("a note can be archived out of the Active list, found under All, and unarchived", async ({
  page,
  withWorkspace,
  e2eWorkerClient,
}) => {
  const workspace = await withWorkspace({ prefix: "notes-archive-" });
  const projectId = await projectIdFor(e2eWorkerClient, workspace.workspaceId);
  const save = async (body: string) =>
    (await e2eWorkerClient.saveNote({ projectId, body })).note.noteId;
  const release = await save("# Release plan\n\nShip on Friday.");
  const retro = await save("# Retro\n\nKeep the demos short.");
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openNotesPanel(page);
  const list = page.getByTestId("notes-list").filter({ visible: true }).first();
  const rows = list.locator('[data-testid^="note-row-"]');
  const scopeAll = page.getByTestId("notes-search-scope-all").filter({ visible: true });
  const scopeActive = page.getByTestId("notes-search-scope-active").filter({ visible: true });
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(scopeActive).toBeVisible();
  await shot(page, "notes-01-active");

  await list.getByTestId(`note-row-${retro}`).click({ button: "right" });
  await expect(page.getByTestId(`note-archive-${retro}`).filter({ visible: true })).toHaveText(
    "Archive",
  );
  await shot(page, "notes-02-menu");
  await page.getByTestId(`note-archive-${retro}`).filter({ visible: true }).click();
  await expect(list.getByTestId(`note-row-${retro}`)).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect
    .poll(async () =>
      (await e2eWorkerClient.listNotes(projectId)).map((note) => [
        note.displayTitle,
        note.archived === true,
      ]),
    )
    .toEqual([
      ["Retro", true],
      ["Release plan", false],
    ]);
  await shot(page, "notes-03-archived-hidden");

  await scopeAll.click();
  await expect(rows).toHaveCount(2);
  await expect(list.getByTestId(`note-row-${retro}`)).toHaveAccessibleName("Retro, Archived");
  await shot(page, "notes-04-all");

  await list.getByTestId(`note-row-${retro}`).click({ button: "right" });
  await page.getByTestId(`note-archive-${retro}`).filter({ visible: true }).click();
  await scopeActive.click();
  await expect(list.getByTestId(`note-row-${retro}`)).toHaveAccessibleName("Retro");
  await expect(rows).toHaveCount(2);

  // With every note archived, Active says so and keeps the toggle in reach.
  for (const noteId of [release, retro]) {
    await list.getByTestId(`note-row-${noteId}`).click({ button: "right" });
    await page.getByTestId(`note-archive-${noteId}`).filter({ visible: true }).click();
    await expect(list.getByTestId(`note-row-${noteId}`)).toHaveCount(0);
  }
  await expect(page.getByTestId("notes-no-active").filter({ visible: true })).toContainText(
    "No active notes",
  );
  await expect(scopeAll).toBeVisible();
  await shot(page, "notes-05-none-active");
});

test("an artifact can be archived out of the Active list, found under All, and unarchived", async ({
  page,
  withWorkspace,
  e2eWorkerClient,
}) => {
  const workspace = await withWorkspace({ prefix: "artifacts-archive-" });
  const projectId = await projectIdFor(e2eWorkerClient, workspace.workspaceId);
  const publish = async (title: string) =>
    (
      await e2eWorkerClient.publishArtifact({
        projectId,
        title,
        html: `<h1>${title}</h1>`,
        externalUrl: null,
      })
    ).artifactId;
  const report = await publish("Q3 report");
  const draft = await publish("Old draft");
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);
  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  const rows = list.locator('[data-testid^="artifact-row-"]');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await shot(page, "artifacts-01-active");

  await list.getByTestId(`artifact-row-${draft}`).click({ button: "right" });
  await page.getByTestId(`artifact-archive-${draft}`).filter({ visible: true }).click();
  await expect(list.getByTestId(`artifact-row-${draft}`)).toHaveCount(0);
  await expect
    .poll(async () =>
      (await e2eWorkerClient.listArtifacts(projectId)).map((artifact) => [
        artifact.title,
        artifact.archived === true,
      ]),
    )
    .toEqual([
      ["Old draft", true],
      ["Q3 report", false],
    ]);
  await shot(page, "artifacts-02-archived-hidden");

  await page.getByTestId("artifacts-search-scope-all").filter({ visible: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(list.getByTestId(`artifact-row-${draft}`)).toHaveAccessibleName(
    "Old draft, Archived",
  );
  // An archived row offers Unarchive and no Pin: pinning would bring it back.
  await list.getByTestId(`artifact-row-${draft}`).click({ button: "right" });
  await expect(page.getByTestId(`artifact-pin-${draft}`)).toHaveCount(0);
  await expect(page.getByTestId(`artifact-archive-${draft}`).filter({ visible: true })).toHaveText(
    "Unarchive",
  );
  await shot(page, "artifacts-03-all-menu");
  await page.getByTestId(`artifact-archive-${draft}`).filter({ visible: true }).click();

  await page.getByTestId("artifacts-search-scope-active").filter({ visible: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(list.getByTestId(`artifact-row-${report}`)).toBeVisible();
  await expect(list.getByTestId(`artifact-row-${draft}`)).toHaveAccessibleName("Old draft");

  // Compact layout uses the same toggle.
  await page.getByTestId(`artifact-row-${draft}`).filter({ visible: true }).click({
    button: "right",
  });
  await page.getByTestId(`artifact-archive-${draft}`).filter({ visible: true }).click();
  // The compact overlay reopens on the Explorer view last shown, Artifacts.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("workspace-explorer-toggle").first().click();
  const compactList = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(compactList.locator('[data-testid^="artifact-row-"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await shot(page, "artifacts-04-compact-active");
  await page.getByTestId("artifacts-search-scope-all").filter({ visible: true }).click();
  await expect(compactList.locator('[data-testid^="artifact-row-"]')).toHaveCount(2);
  await shot(page, "artifacts-05-compact-all");
});
