import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import {
  expectSettingsHeader,
  openHostSection,
  openSettingsHost,
} from "../support/helpers/settings";

/**
 * Captures the agent-messaging settings as QA evidence, per docs/qa.md.
 *
 * It asserts as it goes so a broken surface fails the run instead of quietly producing a
 * screenshot of the breakage. That rule earned its place here: an earlier ad-hoc run of these
 * same checks rendered the settings screen with no errors and zero switches, because the daemon
 * rejected the page's origin. A capture-only script reports that as a pass.
 *
 * The disk assertions are the point of the spec rather than a bonus. Both switches update the
 * in-memory daemon config and acknowledge the patch, so the UI sticks and the daemon behaves
 * correctly whether or not the value was ever written. The only way to tell the difference is to
 * read config.json, which is what caught `mergeMutableAgentPatch` dropping `agents.peerMessaging`.
 *
 * Files land in `qa-evidence/` at the repository root, flat and stably named, so a rerun
 * overwrites the previous set and the names can be quoted in a pull request. The directory is
 * gitignored — screenshots are attached to the pull request, not committed.
 */
const EVIDENCE_DIR = path.resolve(__dirname, "../../../..", "qa-evidence");

const ENFORCE_TITLE = "Limit agent-to-agent messages";
const ENFORCE_HINT =
  "Agents can message related agents and agents working nearby. Other messages ask you first. Turning this on may show approval prompts.";
const CWD_TITLE = "Allow messages to agents in nested folders";
const CWD_HINT =
  "Lets an agent message any agent working in a folder inside its own. Turn this off so agents can only message agents they created, agents that created them, or agents with the same creator.";

/**
 * `animations: "allow"` is required, not a preference. Playwright's default is
 * `animations: "disabled"`, which rewinds finite CSS animations and transitions to their first
 * frame before capturing — and the switch draws its knob position through a transition. On the
 * default, every switch in the shot renders in the off position regardless of its value, so the
 * evidence shows both settings at their defaults at an instant when the DOM carried
 * `aria-checked="true"` and config.json carried the written value. A screenshot that contradicts
 * the assertion beside it is worse than no screenshot: it reads as a failure that did not happen.
 *
 * The settle covers the transition itself, since `toHaveAttribute` resolves the moment the
 * attribute flips, which is before the knob finishes moving.
 */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, `${name}.png`),
    fullPage: true,
    animations: "allow",
  });
}

type PeerMessaging = { enforceReachability?: boolean; cwdReachability?: boolean } | undefined;

async function readPersistedPeerMessaging(): Promise<PeerMessaging> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set (expected from the worker fixture).");
  try {
    const raw = await readFile(path.join(paseoHome, "config.json"), "utf8");
    return (JSON.parse(raw) as { agents?: { peerMessaging?: PeerMessaging } }).agents
      ?.peerMessaging;
  } catch (error) {
    // A daemon that has never persisted a mutable patch has no config.json at all, which is a
    // legitimate starting state rather than a failure.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The patch is written after the response is acknowledged, so a single read races the daemon.
 * Poll rather than sleeping a fixed beat, and fail with what was actually on disk.
 */
async function expectPersisted(expected: Record<string, boolean>): Promise<void> {
  await expect
    .poll(readPersistedPeerMessaging, { timeout: 15_000, intervals: [100, 250, 500] })
    .toMatchObject(expected);
}

test("evidence: agent-messaging settings render, toggle, and persist", async ({ page }) => {
  const serverId = getServerId();
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await openHostSection(page, serverId, "agents");
  await expectSettingsHeader(page, "Agents");

  const enforceCard = page.getByTestId("host-page-peer-messaging-enforce-card");
  const cwdCard = page.getByTestId("host-page-peer-messaging-cwd-card");
  const enforceSwitch = page.getByTestId("host-page-peer-messaging-enforce-switch");
  const cwdSwitch = page.getByTestId("host-page-peer-messaging-cwd-switch");

  await test.step("both cards render with their shipped copy", async () => {
    await expect(enforceCard).toBeVisible({ timeout: 30_000 });
    await expect(cwdCard).toBeVisible();
    // Assert the hints in full. They are the whole explanation a user gets for a setting that
    // changes who may command whom, and a truncated or stale string is the likely regression.
    await expect(enforceCard).toContainText(ENFORCE_TITLE);
    await expect(enforceCard).toContainText(ENFORCE_HINT);
    await expect(cwdCard).toContainText(CWD_TITLE);
    await expect(cwdCard).toContainText(CWD_HINT);
  });

  await test.step("defaults are off and on", async () => {
    // Enforcement ships off: the four reachability rules were derived rather than observed, so
    // the daemon logs what it would have denied until the logs say the rules match real usage.
    await expect(enforceSwitch).toHaveAttribute("aria-checked", "false");
    await expect(cwdSwitch).toHaveAttribute("aria-checked", "true");
    await shot(page, "01-agents-defaults");
  });

  await test.step("turning enforcement on reaches config.json", async () => {
    await enforceSwitch.click();
    await expect(enforceSwitch).toHaveAttribute("aria-checked", "true");
    await expectPersisted({ enforceReachability: true });
    await shot(page, "02-enforce-on");
  });

  await test.step("turning the directory rule off preserves the enforcement flag", async () => {
    // A patch carries one field, so persisting it must merge rather than replace. Writing only
    // cwdReachability here would silently drop the enforcement the user just turned on.
    await cwdSwitch.click();
    await expect(cwdSwitch).toHaveAttribute("aria-checked", "false");
    await expectPersisted({ enforceReachability: true, cwdReachability: false });
    await shot(page, "03-cwd-off");
  });

  await test.step("a reload shows what was persisted, not what was clicked", async () => {
    // A fresh navigation remounts the app and re-reads the daemon config. If the write had not
    // landed, the switches come back at their defaults here — exactly how the bug presented after
    // a daemon restart. `goto("/")` rather than `reload()`, because a reload lands back on the
    // settings route and the sidebar control `openSettings` clicks is not on that screen.
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await openHostSection(page, serverId, "agents");
    await expect(enforceSwitch).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    await expect(cwdSwitch).toHaveAttribute("aria-checked", "false");
    await shot(page, "04-after-reload");
  });
});
