import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { startLocalElixirRelay } from "../support/helpers/local-elixir-relay";
import {
  startPackagedWebDaemon,
  type PackagedWebDaemon,
} from "../support/helpers/packaged-web-daemon";
import { connectDaemonWebAppOnlyThroughRelay } from "../support/helpers/relay-deployment";
import { createTempGitRepo } from "../support/helpers/workspace";

const PROJECT_ID = "prj_relayartifact01";
const WORKSPACE_ID = "wks_relayartifact01";
const ARTIFACT_ID = "art_relayartifact01";
const ARTIFACT_HTML =
  "<h1 id='heading'>Rendered over a relay</h1><p id='body'>No HTTP route reached this.</p>";

const STAMP = "2026-09-01T00:00:00.000Z";

/**
 * Writes a project, a workspace and one stored artifact straight into `$PASEO_HOME`.
 *
 * The registries read their files once at boot, and publishing is agent-only by design, so
 * there is no inbound RPC that could put an artifact here. Seeding before start is what lets
 * the daemon serve a real one.
 */
async function seedArtifactHome(home: string, repoPath: string): Promise<void> {
  const html = Buffer.from(ARTIFACT_HTML, "utf8");
  await mkdir(path.join(home, "projects"), { recursive: true });
  await mkdir(path.join(home, "artifacts", PROJECT_ID), { recursive: true });

  await writeFile(
    path.join(home, "projects", "projects.json"),
    JSON.stringify([
      {
        projectId: PROJECT_ID,
        rootPath: repoPath,
        kind: "git",
        displayName: "Relay artifact",
        projectKey: null,
        customName: null,
        customIconRevision: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        archivedAt: null,
      },
    ]),
  );

  await writeFile(
    path.join(home, "projects", "workspaces.json"),
    JSON.stringify([
      {
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        cwd: repoPath,
        kind: "local_checkout",
        displayName: "main",
        title: null,
        branch: null,
        worktreeRoot: repoPath,
        baseBranch: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: repoPath,
        createdAt: STAMP,
        updatedAt: STAMP,
        archivedAt: null,
      },
    ]),
  );

  await writeFile(
    path.join(home, "artifacts", "index.json"),
    JSON.stringify([
      {
        artifactId: ARTIFACT_ID,
        projectId: PROJECT_ID,
        title: "Rendered over a relay",
        mimeType: "text/html",
        size: html.byteLength,
        contentSha256: createHash("sha256").update(html).digest("hex"),
        createdAt: STAMP,
        updatedAt: STAMP,
        pinned: false,
        externalUrl: null,
        origin: {
          agentId: "agt_seed",
          workspaceId: WORKSPACE_ID,
          provider: "claude",
          callId: null,
        },
      },
    ]),
  );

  await writeFile(path.join(home, "artifacts", PROJECT_ID, `${ARTIFACT_ID}.html`), html);
}

test("an artifact renders over a relay, where the HTTP download route cannot reach", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const relay = await startLocalElixirRelay();
  const repo = await createTempGitRepo("relay-artifact-");
  let daemon: PackagedWebDaemon | null = null;

  try {
    daemon = await startPackagedWebDaemon({
      relayEndpoint: relay.endpoint,
      seedHome: (home) => seedArtifactHome(home, repo.path),
    });
    const runningDaemon = daemon;

    await test.step("Connect the app only through the relay", async () => {
      // Pairing waits on the desktop sidebar, so connect wide and shrink to phone width after.
      // Remote access from a phone is the case this transport exists for.
      await page.setViewportSize({ width: 1400, height: 900 });
      // This blocks port 6767 and aborts non-document HTTP, so nothing below can quietly fall
      // back to `GET /api/files/download` — the route a relay does not carry.
      await connectDaemonWebAppOnlyThroughRelay(page, runningDaemon);
      await page.setViewportSize({ width: 390, height: 844 });
    });

    await test.step("Open the seeded workspace", async () => {
      const route = buildHostWorkspaceRoute(runningDaemon.serverId, WORKSPACE_ID);
      await page.goto(new URL(route, runningDaemon.origin).toString());
      await expect(page.getByTestId("workspace-explorer-toggle").first()).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("Open the Artifacts view in the compact overlay", async () => {
      const toggle = page.getByTestId("workspace-explorer-toggle").first();
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      await toggle.click();
      await page.getByTestId("explorer-tab-artifacts").first().click();
    });

    await test.step("Stream the document over the relay and render it", async () => {
      const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
      await expect(list).toBeVisible({ timeout: 30_000 });
      await list.getByTestId(`artifact-row-${ARTIFACT_ID}`).click();

      const preview = page.getByTestId("artifact-html-preview").filter({ visible: true }).first();
      await expect(preview).toBeVisible({ timeout: 30_000 });
      // The bytes only get here over the WebSocket binary channel.
      await expect(preview.contentFrame().locator("#heading")).toHaveText("Rendered over a relay");
      await expect(preview.contentFrame().locator("#body")).toHaveText(
        "No HTTP route reached this.",
      );
      // Tapping a row dismisses the overlay on compact; let it finish so the shot is not a
      // half-drawn panel over the document.
      await expect(page.getByTestId("artifacts-list")).toBeHidden({ timeout: 15_000 });
      await page.screenshot({ path: testInfo.outputPath("11-relay-mobile-artifact.png") });
    });
  } finally {
    await daemon?.close().catch(() => undefined);
    await relay.close().catch(() => undefined);
    await repo.cleanup().catch(() => undefined);
  }
});
