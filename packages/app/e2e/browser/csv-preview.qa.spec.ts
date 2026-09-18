import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const fixturePath = path.resolve(__dirname, "../fixtures/csv-preview.csv");
const fixtureContent = readFileSync(fixturePath, "utf8");
const demoVideo = process.env.E2E_DEMO_VIDEO === "1";

function screenshotPath(testInfo: import("@playwright/test").TestInfo, filename: string): string {
  return demoVideo
    ? path.resolve(__dirname, "../../../../qa-evidence/video/web-screenshots", filename)
    : testInfo.outputPath(filename);
}

let workspace: SeededWorkspace;

async function pauseForDemo(page: import("@playwright/test").Page, milliseconds = 1_800) {
  if (demoVideo) await page.waitForTimeout(milliseconds);
}

async function openCsvPreview(page: import("@playwright/test").Page): Promise<void> {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);
  await openFileFromExplorer(page, "csv-preview.csv");
  await expect(page.getByTestId("csv-preview")).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "csv-preview-qa-",
    repo: { files: [{ path: "csv-preview.csv", content: fixtureContent }] },
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test("opens the real CSV file and exercises the preview interactions", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  await openCsvPreview(page);
  const csvPreview = page.getByTestId("csv-preview");
  await expect(page.getByTestId("csv-header-row")).toBeVisible();
  await expect(page.getByTestId("csv-ragged-banner")).toBeVisible();
  await expect(page.getByTestId("csv-cell-0-4")).toContainText("Quoted, comma");
  await expect(page.getByTestId("csv-cell-6-5")).toHaveCount(0);
  await pauseForDemo(page, 2_000);
  await page.screenshot({
    path: screenshotPath(testInfo, "01-grid-ragged-quoted.png"),
    fullPage: true,
  });

  const amountCell = page.getByTestId("csv-cell-0-2");
  const amountTextAlign = await amountCell.evaluate((element) => {
    const text = element.querySelector<HTMLElement>("[data-testid]") ?? element;
    return getComputedStyle(text).textAlign;
  });
  const nameTextAlign = await page.getByTestId("csv-cell-0-1").evaluate((element) => {
    const text = element.querySelector<HTMLElement>("[data-testid]") ?? element;
    return getComputedStyle(text).textAlign;
  });
  const amountHeaderTextAlign = await page
    .getByTestId("csv-sort-2")
    .evaluate((element) => getComputedStyle(element).textAlign);
  const nameHeaderTextAlign = await page
    .getByTestId("csv-sort-1")
    .evaluate((element) => getComputedStyle(element).textAlign);
  console.log(
    "[csv-qa] alignment",
    amountTextAlign,
    nameTextAlign,
    amountHeaderTextAlign,
    nameHeaderTextAlign,
  );
  expect.soft(amountTextAlign).toBe("right");
  expect.soft(nameTextAlign).toBe("left");
  expect.soft(amountHeaderTextAlign).toBe("right");
  expect.soft(nameHeaderTextAlign).toBe("left");

  const search = page.getByTestId("csv-search");
  if (demoVideo) {
    await search.click();
    for (const term of ["P", "Pa", "Par", "Pari", "Paris"]) {
      await search.fill(term);
      await page.waitForTimeout(140);
    }
  } else {
    await search.fill("Paris");
  }
  await expect(page.getByTestId("csv-row-0")).toHaveCount(0);
  await expect(page.getByTestId("csv-row-1")).toBeVisible();
  await expect(page.getByTestId("csv-row-5")).toBeVisible();
  for (const rowIndex of [2, 3, 4, 6]) {
    await expect(page.getByTestId(`csv-row-${rowIndex}`)).toHaveCount(0);
  }
  const highlighted = await page.getByTestId("csv-cell-1-3").evaluate((element) =>
    Array.from(element.querySelectorAll<HTMLElement>("*"))
      .filter((child) => child.textContent?.includes("Paris"))
      .some((child) => {
        const background = getComputedStyle(child).backgroundColor;
        return background !== "transparent" && background !== "rgba(0, 0, 0, 0)";
      }),
  );
  expect(highlighted).toBe(true);
  await pauseForDemo(page);
  await page.screenshot({
    path: screenshotPath(testInfo, "02-search-paris-highlighted.png"),
    fullPage: true,
  });

  await page.getByTestId("csv-clear-filters").click();
  await expect(page.getByTestId("csv-row-0")).toBeVisible();

  await page.getByTestId("csv-sort-1").hover();
  await page.getByTestId("csv-filter-1").click();
  await expect(page.getByTestId("csv-filter-menu-1")).toBeVisible();
  await pauseForDemo(page, 1_200);
  const activeFilter = page.getByTestId("csv-filter-value-1-Active");
  await activeFilter.click({ position: { x: 8, y: 12 } });
  await pauseForDemo(page);
  console.log(
    "[csv-qa] after Active filter",
    await page
      .locator('[data-testid^="csv-row-"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid"))),
    await activeFilter.getAttribute("aria-checked"),
    await activeFilter.getAttribute("aria-selected"),
  );
  await expect(page.getByTestId("csv-row-0")).toBeVisible();
  await expect(page.getByTestId("csv-row-2")).toBeVisible();
  await expect(page.getByTestId("csv-row-5")).toBeVisible();
  await expect(page.getByTestId("csv-row-6")).toBeVisible();
  await expect.soft(page.getByTestId("csv-row-1")).toHaveCount(0);
  await expect.soft(page.getByTestId("csv-row-3")).toHaveCount(0);
  await expect.soft(page.getByTestId("csv-row-4")).toHaveCount(0);
  await page.screenshot({
    path: screenshotPath(testInfo, "03-status-active-filter.png"),
    fullPage: true,
  });

  await pauseForDemo(page, 1_000);
  await page.reload();
  await openCsvPreview(page);
  await pauseForDemo(page, 1_500);

  const sortTarget = page.getByTestId("csv-sort-2");
  await sortTarget.click({ position: { x: 8, y: 18 } });
  await page.waitForTimeout(250);
  await pauseForDemo(page);
  const sortState = await sortTarget.getAttribute("aria-sort");
  const sortedRows = await page
    .locator('[data-testid^="csv-row-"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")));
  console.log("[csv-qa] after amount sort", sortState, sortedRows);
  expect.soft(sortState).toBe("ascending");
  expect
    .soft(sortedRows)
    .toEqual([
      "csv-row-1",
      "csv-row-6",
      "csv-row-4",
      "csv-row-0",
      "csv-row-3",
      "csv-row-5",
      "csv-row-2",
    ]);
  await page.screenshot({
    path: screenshotPath(testInfo, "04-numeric-sort-ascending.png"),
    fullPage: true,
  });

  const frozenHeader = page.getByTestId("csv-spike-header-cell-0");
  const scrollingHeader = page.getByTestId("csv-spike-header-body");
  const before = await frozenHeader.boundingBox();
  const grid = page.getByTestId("csv-grid");
  const gridBox = await grid.boundingBox();
  if (!before || !gridBox) throw new Error("CSV grid did not expose measurable bounds");
  await page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height / 2);
  await page.mouse.wheel(320, 0);
  await page.waitForTimeout(250);
  await pauseForDemo(page);
  const scrollTransform = await scrollingHeader.getAttribute("style");
  const after = await frozenHeader.boundingBox();
  console.log("[csv-qa] after horizontal pan", scrollTransform, before.x, after?.x);
  expect.soft(scrollTransform).toMatch(/translateX\(-/);
  expect.soft(after?.x).toBe(before.x);
  await page.screenshot({
    path: screenshotPath(testInfo, "05-horizontal-pan-column-zero-pinned.png"),
    fullPage: true,
  });

  await page.getByTestId("file-mode-source").click();
  await page.waitForTimeout(250);
  await pauseForDemo(page);
  const sourceVisible = await page
    .getByTestId("file-source-editor")
    .isVisible()
    .catch(() => false);
  console.log("[csv-qa] after Source toggle", sourceVisible);
  expect.soft(sourceVisible).toBe(true);
  await page.screenshot({
    path: screenshotPath(testInfo, "06-source-mode.png"),
    fullPage: true,
  });
  await page.getByTestId("file-mode-preview").click();
  await page.waitForTimeout(250);
  await pauseForDemo(page, 2_000);
  const previewVisible = await csvPreview.isVisible().catch(() => false);
  console.log("[csv-qa] after Preview toggle", previewVisible);
  expect.soft(previewVisible).toBe(true);
  await page.screenshot({
    path: screenshotPath(testInfo, "07-preview-round-trip.png"),
    fullPage: true,
  });
});

type Page = import("@playwright/test").Page;
type Locator = import("@playwright/test").Locator;

/** How the user reaches the grid: a mouse on a wide layout, or a finger on a phone-sized one. */
interface Pointer {
  touch: boolean;
}

const MOUSE: Pointer = { touch: false };
const FINGER: Pointer = { touch: true };

// QA_EVIDENCE=1 records the screenshots, the walkthrough video and the save timings below.
const qaEvidence = process.env.QA_EVIDENCE === "1";
const evidenceDirectory = path.resolve(__dirname, "../../../../qa-evidence/csv-cell-edit");

function evidencePath(filename: string): string {
  return path.join(evidenceDirectory, filename);
}

async function press(pointer: Pointer, locator: Locator): Promise<void> {
  if (pointer.touch) await locator.tap();
  else await locator.click();
}

async function openCsvFile(page: Page, ...explorerPath: string[]): Promise<void> {
  const isCompact = (page.viewportSize()?.width ?? 1280) < 768;
  if (isCompact) {
    // The compact shell has no tab row for `gotoWorkspace` to wait on.
    await page.goto(`/h/${process.env.E2E_SERVER_ID}/workspace/${workspace.workspaceId}`);
    await expect(page.getByTestId("compact-shell")).toBeVisible({ timeout: 30_000 });
  } else {
    await gotoWorkspace(page, workspace.workspaceId);
  }
  await openFileExplorer(page);
  for (const entry of explorerPath) await openFileFromExplorer(page, entry);
  await expect(page.getByTestId("csv-preview")).toBeVisible({ timeout: 30_000 });
}

async function editCell(
  page: Page,
  pointer: Pointer,
  cellTestId: string,
  value: string,
): Promise<void> {
  await press(pointer, page.getByTestId(cellTestId));
  await page.getByTestId("csv-value-input").fill(value);
  await press(pointer, page.getByTestId("csv-edit-save"));
  await expect(page.getByTestId("csv-value-input")).toHaveCount(0);
}

/** The edit reached the disk exactly, and the panel says it has nothing left to save. */
async function expectSaved(page: Page, filePath: string, expected: string): Promise<void> {
  await expect.poll(() => readFile(filePath, "utf8"), { timeout: 15_000 }).toBe(expected);
  // In Preview the status holds nothing while clean, so it has no size to be visible with.
  await expect(page.getByLabel("Editor status clean")).toBeAttached();
}

const cannotLockDirectories = process.platform === "win32" || process.getuid?.() === 0;

function defineEditingTests(pointer: Pointer): void {
  // Each layout edits its own files, so one run never reads what the other left behind.
  const suffix = pointer.touch ? "-touch" : "";

  test("edits one cell, saves only that field, and undoes it byte for byte", async ({ page }) => {
    const original = '﻿name,city,notes\r\nAda,London,"said ""hi"", twice"\r\nGrace,Paris,plain\r\n';
    const fileName = `edit-cell${suffix}.csv`;
    const filePath = path.join(workspace.repoPath, fileName);
    await writeFile(filePath, original, "utf8");

    await openCsvFile(page, fileName);
    await editCell(page, pointer, "csv-cell-1-1", "Lyon, FR");

    await expectSaved(
      page,
      filePath,
      original.replace("Grace,Paris,plain", 'Grace,"Lyon, FR",plain'),
    );
    await expect(page.getByTestId("csv-cell-1-1")).toHaveText("Lyon, FR");

    await press(pointer, page.getByTestId("file-mode-source"));
    await expect(page.getByTestId("file-source-editor")).toContainText('Grace,"Lyon, FR",plain');
    await press(pointer, page.getByTestId("file-mode-preview"));

    await press(pointer, page.getByTestId("csv-undo-edit"));
    await expectSaved(page, filePath, original);
    await expect(page.getByTestId("csv-cell-1-1")).toHaveText("Paris");
    await expect(page.getByTestId("csv-undo-edit")).toHaveCount(0);
  });

  test("keeps the header mode and undo across Source and back", async ({ page }) => {
    const original = "1,2\r\n3,4\r\n5,6\r\n";
    const fileName = `numbers${suffix}.csv`;
    const filePath = path.join(workspace.repoPath, fileName);
    await writeFile(filePath, original, "utf8");

    await openCsvFile(page, fileName);
    await expect(page.getByTestId("csv-row-2")).toBeVisible();
    await editCell(page, pointer, "csv-cell-0-0", "Name");
    await expectSaved(page, filePath, "Name,2\r\n3,4\r\n5,6\r\n");

    await press(pointer, page.getByTestId("file-mode-source"));
    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await press(pointer, page.getByTestId("file-mode-preview"));

    // Inferring the header again would turn the edited first row into a header and leave two rows.
    await expect(page.getByTestId("csv-cell-0-0")).toHaveText("Name");
    await expect(page.getByTestId("csv-row-2")).toBeVisible();
    await press(pointer, page.getByTestId("csv-undo-edit"));
    await expectSaved(page, filePath, original);
  });

  test("shows a failed save and recovers with Retry", async ({ page }) => {
    test.skip(cannotLockDirectories, "Needs a directory the daemon cannot write to");
    const directoryName = `retry${suffix}`;
    const directory = path.join(workspace.repoPath, directoryName);
    const filePath = path.join(directory, "people.csv");
    const original = "name,city\nAda,London\n";
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, original, "utf8");

    await openCsvFile(page, directoryName, "people.csv");
    await chmod(directory, 0o555);
    try {
      await editCell(page, pointer, "csv-cell-0-1", "Leeds");
      await expect(page.getByTestId("csv-save-failed")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("csv-cell-0-1")).toHaveText("Leeds");
      expect(await readFile(filePath, "utf8")).toBe(original);
    } finally {
      await chmod(directory, 0o755);
    }

    await press(pointer, page.getByTestId("csv-save-retry"));
    await expectSaved(page, filePath, "name,city\nAda,Leeds\n");
    await expect(page.getByTestId("csv-save-failed")).toHaveCount(0);
  });

  test("keeps the disk untouched in a conflict and reloads it into the grid", async ({ page }) => {
    test.skip(cannotLockDirectories, "Needs a directory the daemon cannot write to");
    const directoryName = `conflict${suffix}`;
    const directory = path.join(workspace.repoPath, directoryName);
    const filePath = path.join(directory, "people.csv");
    const external = "name,city\nAda,Bristol\nGrace,Paris\n";
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, "name,city\nAda,London\n", "utf8");

    await openCsvFile(page, directoryName, "people.csv");
    // A save that cannot finish leaves the edit in the buffer, so the change on disk meets it.
    await chmod(directory, 0o555);
    try {
      await editCell(page, pointer, "csv-cell-0-1", "Leeds");
      await expect(page.getByTestId("csv-save-failed")).toBeVisible({ timeout: 15_000 });
      await writeFile(filePath, external, "utf8");
      await expect(page.getByTestId("file-conflict-alert")).toBeVisible({ timeout: 15_000 });
    } finally {
      await chmod(directory, 0o755);
    }

    // The directory is writable again, so only the conflict keeps the undo from reaching the disk.
    await press(pointer, page.getByTestId("csv-undo-edit"));
    await expect(page.getByTestId("csv-cell-0-1")).toHaveText("London");
    // Longer than the autosave delay.
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    expect(await readFile(filePath, "utf8")).toBe(external);

    await press(pointer, page.getByRole("button", { name: "Reload", exact: true }));
    await expect(page.getByTestId("csv-cell-0-1")).toHaveText("Bristol");
    await expect(page.getByTestId("csv-row-1")).toBeVisible();
    await expect(page.getByTestId("file-conflict-alert")).toHaveCount(0);
    expect(await readFile(filePath, "utf8")).toBe(external);
  });
}

defineEditingTests(MOUSE);

test.describe("on a phone-sized touch viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  defineEditingTests(FINGER);

  test("opens a sheet editor that takes focus on tap, keeps Save in view, and cancels", async ({
    page,
  }) => {
    const original = "name,city\nAda,London\nGrace,Paris\n";
    const filePath = path.join(workspace.repoPath, "sheet-touch.csv");
    await writeFile(filePath, original, "utf8");

    await openCsvFile(page, "sheet-touch.csv");
    await page.getByTestId("csv-cell-0-1").tap();
    const input = page.getByTestId("csv-value-input");
    await expect(input).toHaveValue("London");
    // Opening the sheet must not raise the keyboard over it; the field takes focus when tapped.
    await expect(input).not.toBeFocused();
    await input.tap();
    await expect(input).toBeFocused();
    await expect(page.getByTestId("csv-edit-save")).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("csv-edit-cancel")).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("csv-copy-cell")).toBeInViewport({ ratio: 1 });

    await input.fill("Leeds");
    if (qaEvidence) {
      await page.screenshot({ path: evidencePath("02-editable-sheet-phone.png") });
    }
    await page.getByTestId("csv-edit-cancel").tap();
    await expect(input).toHaveCount(0);
    await expect(page.getByTestId("csv-cell-0-1")).toHaveText("London");
    await expect(page.getByTestId("csv-undo-edit")).toHaveCount(0);
    expect(await readFile(filePath, "utf8")).toBe(original);

    await editCell(page, FINGER, "csv-cell-0-1", "Leeds");
    await expectSaved(page, filePath, "name,city\nAda,Leeds\nGrace,Paris\n");
    await expect(page.getByTestId("csv-undo-edit")).toBeInViewport({ ratio: 1 });
  });
});

test.describe("QA evidence", () => {
  test.skip(!qaEvidence, "Set QA_EVIDENCE=1 to record screenshots, a video and save timings");
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeAll(async () => {
    if (qaEvidence) await mkdir(evidenceDirectory, { recursive: true });
  });

  test("records the editing states", async ({ page }) => {
    test.setTimeout(180_000);
    const original = "name,city,notes\nAda,London,short\nGrace,Paris,plain\nLin,Tokyo,ok\n";
    const filePath = path.join(workspace.repoPath, "evidence.csv");
    await writeFile(filePath, original, "utf8");

    await openCsvFile(page, "evidence.csv");
    await page.getByTestId("csv-cell-0-1").click();
    await expect(page.getByTestId("csv-value-input")).toBeFocused();
    await page.screenshot({ path: evidencePath("01-editable-sheet-desktop.png") });

    await page.getByTestId("csv-value-input").fill("Leeds, typed before the file changed");
    const rewritten = `${original}Mei,Osaka,added by another writer\n`;
    await writeFile(filePath, rewritten, "utf8");
    await expect(page.getByTestId("csv-edit-error")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("csv-value-input")).toHaveValue(
      "Leeds, typed before the file changed",
    );
    await page.screenshot({ path: evidencePath("04-stale-draft-text-retained.png") });
    await page.getByTestId("csv-edit-cancel").click();
    await expect(page.getByTestId("csv-row-3")).toBeVisible();

    const notesCell = page.getByTestId("csv-cell-0-2");
    const widthBefore = (await notesCell.boundingBox())?.width;
    await page.screenshot({ path: evidencePath("09-column-widths-before-edit.png") });
    const longNote = "a much longer note that would widen this column if it were measured again";
    await editCell(page, MOUSE, "csv-cell-0-2", longNote);
    await expectSaved(
      page,
      filePath,
      rewritten.replace("Ada,London,short", `Ada,London,${longNote}`),
    );
    expect((await notesCell.boundingBox())?.width).toBe(widthBefore);
    await page.screenshot({ path: evidencePath("10-column-widths-after-edit.png") });
    await page.getByTestId("csv-toolbar").screenshot({ path: evidencePath("05-undo-button.png") });

    const tsvPath = path.join(workspace.repoPath, "evidence.tsv");
    await writeFile(tsvPath, "name\tcity\nAda\tLondon\n", "utf8");
    await openCsvFile(page, "evidence.tsv");
    await page.getByTestId("csv-cell-0-1").click();
    await page.getByTestId("csv-value-input").fill("Lon\tdon");
    await page.getByTestId("csv-edit-save").click();
    await expect(page.getByTestId("csv-edit-error")).toBeVisible();
    await page.screenshot({ path: evidencePath("06-tsv-edit-rejected.png") });
    expect(await readFile(tsvPath, "utf8")).toBe("name\tcity\nAda\tLondon\n");

    // Above the 1 MiB edit limit the panel has no editor, which is also what native shows.
    const largeRows = Array.from(
      { length: 9_000 },
      (_, index) => `${index},name-${index},${"x".repeat(110)},city-${index % 50}`,
    );
    const largePath = path.join(workspace.repoPath, "evidence-large.csv");
    await writeFile(largePath, `id,name,notes,city\n${largeRows.join("\n")}\n`, "utf8");
    await openCsvFile(page, "evidence-large.csv");
    await page.getByTestId("csv-cell-0-1").click();
    await expect(page.getByTestId("csv-value-text")).toHaveText("name-0");
    await expect(page.getByTestId("csv-value-input")).toHaveCount(0);
    await expect(page.getByTestId("csv-edit-save")).toHaveCount(0);
    await page.screenshot({ path: evidencePath("03-readonly-sheet-no-editor.png") });
  });

  test("records a failed save and a conflict", async ({ page }) => {
    test.skip(cannotLockDirectories, "Needs a directory the daemon cannot write to");
    const directory = path.join(workspace.repoPath, "evidence-locked");
    const filePath = path.join(directory, "people.csv");
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, "name,city\nAda,London\nGrace,Paris\n", "utf8");

    await openCsvFile(page, "evidence-locked", "people.csv");
    await chmod(directory, 0o555);
    try {
      await editCell(page, MOUSE, "csv-cell-0-1", "Leeds");
      await expect(page.getByTestId("csv-save-failed")).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: evidencePath("07-save-failed-retry.png") });
      await writeFile(filePath, "name,city\nAda,Bristol\nGrace,Paris\n", "utf8");
      await expect(page.getByTestId("file-conflict-alert")).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: evidencePath("08-conflict-callout.png") });
    } finally {
      await chmod(directory, 0o755);
    }
  });

  test("measures the time from Save to the edited cell on a 1 MiB file", async ({ page }) => {
    test.setTimeout(180_000);
    const notes = "x".repeat(80);
    const rows = Array.from(
      { length: 10_000 },
      (_, index) => `${index},name-${index},${notes},city-${index % 50}`,
    );
    const original = `id,name,notes,city\n${rows.join("\n")}\n`;
    const filePath = path.join(workspace.repoPath, "evidence-1mib.csv");
    expect(Buffer.byteLength(original)).toBeGreaterThan(1_000_000);
    expect(Buffer.byteLength(original)).toBeLessThan(1024 * 1024 - 64);
    await writeFile(filePath, original, "utf8");

    await openCsvFile(page, "evidence-1mib.csv");
    // The header and 10,000 rows are one record more than the grid keeps.
    await expect(page.getByTestId("csv-truncated-banner")).toBeVisible();

    const timings: number[] = [];
    let value = "city-0";
    for (let run = 0; run < 7; run += 1) {
      value = `edited-${run}`;
      await page.getByTestId("csv-cell-0-3").click();
      await page.getByTestId("csv-value-input").fill(value);
      timings.push(await timeSaveToPaintedCell(page, "csv-cell-0-3", value));
      await expect
        .poll(async () => (await readFile(filePath, "utf8")).startsWith(savedHead(notes, value)), {
          timeout: 15_000,
        })
        .toBe(true);
    }

    // Everything outside the one field is the file as written, the row past the grid's cap included.
    const expectedRows = [...rows];
    expectedRows[0] = `0,name-0,${notes},${value}`;
    await expectSaved(page, filePath, `id,name,notes,city\n${expectedRows.join("\n")}\n`);

    // The same grid redrawing without an edit, to tell the edit's cost from the redraw's.
    const closeSheet: number[] = [];
    const resort: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      await page.getByTestId("csv-cell-0-3").click();
      await expect(page.getByTestId("csv-value-input")).toBeVisible();
      closeSheet.push(
        await timeClickUntil(page, "csv-edit-cancel", '[data-testid="csv-value-input"]', false),
      );
      await page.getByTestId("csv-sort-0").click({ position: { x: 8, y: 18 } });
      await expect(page.getByTestId("csv-row-0")).toBeVisible();
      // The grid keeps 10,000 records, so the last body row is index 9,998.
      resort.push(await timeClickUntil(page, "csv-sort-0", '[data-testid="csv-row-9998"]', true));
      await page.getByTestId("csv-sort-0").click({ position: { x: 8, y: 18 } });
      await expect(page.getByTestId("csv-row-0")).toBeVisible();
    }

    const report = {
      bytes: Buffer.byteLength(original),
      rows: rows.length,
      saveToPaintedCellMs: summarize(timings),
      baselineCancelSheetMs: summarize(closeSheet),
      baselineResortMs: summarize(resort),
    };
    console.log("[csv-qa] save to painted cell", JSON.stringify(report));
    await writeFile(evidencePath("save-latency.json"), `${JSON.stringify(report, null, 2)}\n`);
  });

  test.describe("walkthrough", () => {
    test.use({ viewport: { width: 960, height: 540 } });

    test("records editing a cell, the save, Source, and undo", async ({ page }) => {
      // Playwright only takes the video setting from the config, which E2E_RECORD_VIDEO=1 turns on.
      const video = page.video();
      test.skip(!video, "Set E2E_RECORD_VIDEO=1 to record the walkthrough");
      test.setTimeout(120_000);
      const original = "name,city,notes\nAda,London,short\nGrace,Paris,plain\nLin,Tokyo,ok\n";
      const filePath = path.join(workspace.repoPath, "walkthrough.csv");
      await writeFile(filePath, original, "utf8");

      await openCsvFile(page, "walkthrough.csv");
      await page.waitForTimeout(2_000);
      await page.getByTestId("csv-cell-1-1").click();
      await page.waitForTimeout(1_500);
      const input = page.getByTestId("csv-value-input");
      await input.fill("");
      await input.pressSequentially("Lyon, FR", { delay: 110 });
      await page.waitForTimeout(1_000);
      await page.getByTestId("csv-edit-save").click();
      const edited = original.replace("Grace,Paris,plain", 'Grace,"Lyon, FR",plain');
      await expectSaved(page, filePath, edited);
      await page.waitForTimeout(2_500);

      await page.getByTestId("file-mode-source").click();
      await expect(page.getByTestId("file-source-editor")).toContainText('Grace,"Lyon, FR",plain');
      await page.waitForTimeout(3_000);
      await page.getByTestId("file-mode-preview").click();
      await expect(page.getByTestId("csv-undo-edit")).toBeVisible();
      await page.waitForTimeout(2_000);

      await page.getByTestId("csv-undo-edit").click();
      await expectSaved(page, filePath, original);
      await expect(page.getByTestId("csv-cell-1-1")).toHaveText("Paris");
      await page.waitForTimeout(2_500);

      await page.close();
      await video?.saveAs(evidencePath("csv-cell-edit-walkthrough.webm"));
    });
  });
});

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    runs: samples.map((ms) => Math.round(ms)),
    median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    max: Math.round(sorted.at(-1) ?? 0),
  };
}

/** Milliseconds from a press to the first frame in which `selector` is present or absent. */
async function timeClickUntil(page: Page, testId: string, selector: string, present: boolean) {
  return page.evaluate(
    ({ buttonSelector, awaited, shouldExist }) => {
      const button = document.querySelector(buttonSelector);
      if (!(button instanceof HTMLElement)) throw new Error(`Missing ${buttonSelector}`);
      const startedAt = performance.now();
      button.click();
      return new Promise<number>((resolve) => {
        function check(): void {
          if ((document.querySelector(awaited) !== null) === shouldExist) {
            requestAnimationFrame(() => resolve(performance.now() - startedAt));
            return;
          }
          requestAnimationFrame(check);
        }
        check();
      });
    },
    { buttonSelector: `[data-testid="${testId}"]`, awaited: selector, shouldExist: present },
  );
}

function savedHead(notes: string, value: string): string {
  return `id,name,notes,city\n0,name-0,${notes},${value}\n`;
}

/** Milliseconds from the Save press to the first frame that shows the new value in the cell. */
async function timeSaveToPaintedCell(page: Page, cellTestId: string, value: string) {
  return page.evaluate(
    ({ cellSelector, expected }) => {
      const save = document.querySelector('[data-testid="csv-edit-save"]');
      if (!(save instanceof HTMLElement)) throw new Error("Save button is missing");
      const startedAt = performance.now();
      save.click();
      return new Promise<number>((resolve) => {
        function check(): void {
          if (document.querySelector(cellSelector)?.textContent === expected) {
            requestAnimationFrame(() => resolve(performance.now() - startedAt));
            return;
          }
          requestAnimationFrame(check);
        }
        check();
      });
    },
    { cellSelector: `[data-testid="${cellTestId}"]`, expected: value },
  );
}
