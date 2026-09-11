import path from "node:path";

import type { Page } from "@playwright/test";
import { expect, test as baseTest } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerEditable,
} from "../support/helpers/composer";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { openSettingsSection } from "../support/helpers/settings";

/**
 * Captures the third composer send chord as QA evidence, per docs/qa.md.
 *
 * `composer-send-key.spec.ts` owns the behaviour. This spec exists for the two things a behaviour
 * assertion cannot show: that the option list reads as three real chords, and that the Mod option
 * is named after the key the viewer's OS actually has.
 *
 * It also pins the regression that shipped with the Shift+Enter row. The stored values are
 * `"shift-enter"` and `"meta-enter"` while the translation keys are `shiftEnter` and `metaEnter`,
 * so the old `t(` + template-literal lookup missed and the menu rendered the raw key path
 * `settings.general.sendKey.options.shift-enter` as the option label. Asserting the three labels
 * and the absence of any `settings.general` text is what keeps a dynamic key from drifting back.
 *
 * Files land in `qa-evidence/` at the repository root, flat and stably named, so a rerun
 * overwrites the previous set and the names can be quoted in a pull request. The directory is
 * gitignored — screenshots are attached to the pull request, not committed.
 */
const EVIDENCE_DIR = path.resolve(__dirname, "../../../..", "qa-evidence");

/**
 * The option label follows the OS, because the chord is named after the key people press.
 * `getShortcutOs()` reads the user agent on web, and Chromium reports the host platform, so the
 * runner's platform is the same answer the app arrives at.
 */
const MOD_LABEL = process.platform === "darwin" ? "Cmd" : "Ctrl";

const HINTS = {
  enter: "Enter sends. Shift+Enter inserts a line break.",
  shiftEnter: "Shift+Enter sends. Enter inserts a line break.",
  metaEnter: `${MOD_LABEL}+Enter sends. Enter and Shift+Enter insert a line break.`,
};

const test = baseTest.extend<{ agent: MockAgentWorkspace }>({
  agent: async ({ page: _page }, provide) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-send-key-evidence-",
      title: "Composer send key evidence",
    });
    await provide(agent);
    await agent.cleanup();
  },
});

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, `${name}.png`),
    fullPage: true,
    animations: "allow",
  });
}

function sendKeyRow(page: Page) {
  return page.getByRole("button", { name: /^Send message with: / });
}

test("evidence: the composer offers three send chords and Mod+Enter sends", async ({
  page,
  agent,
}) => {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "general");

  await test.step("the row ships with Enter selected and its chords spelled out", async () => {
    await expect(page.getByText("Send message with", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(sendKeyRow(page)).toHaveAccessibleName("Send message with: Enter");
    await expect(page.getByText(HINTS.enter, { exact: true })).toBeVisible();
    await shot(page, "01-send-key-default-enter");
  });

  await test.step("all three options are named after the keys, not their storage values", async () => {
    await sendKeyRow(page).click();
    for (const label of ["Enter", "Shift+Enter", `${MOD_LABEL}+Enter`]) {
      await expect(page.getByRole("menuitem", { name: label, exact: true })).toBeVisible();
    }
    // The regression this replaces: a missed lookup renders the key path as the label.
    await expect(page.getByRole("menuitem", { name: /settings\.general/ })).toHaveCount(0);
    await shot(page, "02-send-key-three-options");
  });

  await test.step(`choosing ${MOD_LABEL}+Enter updates the row and its hint`, async () => {
    await page.getByRole("menuitem", { name: `${MOD_LABEL}+Enter`, exact: true }).click();
    await expect(sendKeyRow(page)).toHaveAccessibleName(`Send message with: ${MOD_LABEL}+Enter`);
    await expect(page.getByText(HINTS.metaEnter, { exact: true })).toBeVisible();
    await shot(page, "03-send-key-mod-enter-selected");
  });

  await openAgentRoute(page, agent);
  await expectComposerEditable(page);
  const composer = composerLocator(page);

  await test.step("Enter and Shift+Enter both fall through as line breaks", async () => {
    await composer.fill("first line");
    await composer.press("Enter");
    await composer.pressSequentially("second line");
    await composer.press("Shift+Enter");
    await composer.pressSequentially("third line");
    await expectComposerDraft(page, "first line\nsecond line\nthird line");
    // Nothing left the composer: under this chord neither bare Enter press is a send.
    await expect(page.getByTestId("user-message")).toHaveCount(0);
    await shot(page, "04-bare-chords-insert-line-breaks");
  });

  await test.step(`${MOD_LABEL}+Enter sends the draft`, async () => {
    await composer.press("ControlOrMeta+Enter");
    await expectComposerDraft(page, "");
    await expect(page.getByTestId("user-message").filter({ hasText: "third line" })).toBeVisible({
      timeout: 30_000,
    });
    await shot(page, "05-mod-enter-sends");
  });

  await test.step("switching back to Shift+Enter restores the old chord", async () => {
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsSection(page, "general");
    await sendKeyRow(page).click();
    await page.getByRole("menuitem", { name: "Shift+Enter", exact: true }).click();
    await expect(sendKeyRow(page)).toHaveAccessibleName("Send message with: Shift+Enter");
    await expect(page.getByText(HINTS.shiftEnter, { exact: true })).toBeVisible();
    await shot(page, "06-send-key-back-to-shift-enter");
  });
});
