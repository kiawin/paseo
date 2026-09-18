import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const fixturePath = path.resolve(__dirname, "../../../../qa-evidence/fixtures/csv-preview.csv");
const fixtureContent = readFileSync(fixturePath, "utf8");
const demoVideo = process.env.E2E_DEMO_VIDEO === "1";
const evidenceDir = demoVideo
  ? path.resolve(__dirname, "../../../../qa-evidence/video/web-screenshots")
  : path.resolve(__dirname, "../../../../qa-evidence/web");

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

test("opens the real CSV file and exercises the preview interactions", async ({ page }) => {
  test.setTimeout(120_000);

  await openCsvPreview(page);
  const csvPreview = page.getByTestId("csv-preview");
  await expect(page.getByTestId("csv-header-row")).toBeVisible();
  await expect(page.getByTestId("csv-ragged-banner")).toBeVisible();
  await expect(page.getByTestId("csv-cell-0-4")).toContainText("Quoted, comma");
  await expect(page.getByTestId("csv-cell-6-5")).toHaveCount(0);
  await pauseForDemo(page, 2_000);
  await page.screenshot({
    path: path.join(evidenceDir, "01-grid-ragged-quoted.png"),
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
    path: path.join(evidenceDir, "02-search-paris-highlighted.png"),
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
    path: path.join(evidenceDir, "03-status-active-filter.png"),
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
    path: path.join(evidenceDir, "04-numeric-sort-ascending.png"),
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
    path: path.join(evidenceDir, "05-horizontal-pan-column-zero-pinned.png"),
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
  await page.screenshot({ path: path.join(evidenceDir, "06-source-mode.png"), fullPage: true });
  await page.getByTestId("file-mode-preview").click();
  await page.waitForTimeout(250);
  await pauseForDemo(page, 2_000);
  const previewVisible = await csvPreview.isVisible().catch(() => false);
  console.log("[csv-qa] after Preview toggle", previewVisible);
  expect.soft(previewVisible).toBe(true);
  await page.screenshot({
    path: path.join(evidenceDir, "07-preview-round-trip.png"),
    fullPage: true,
  });
});
