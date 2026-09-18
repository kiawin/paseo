import { _electron as electron, expect } from "playwright/test";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { warmMetro } from "../../app/e2e/support/metro-warmup.mjs";
const daemonRegistryModule = await import("../../app/e2e/support/helpers/daemon-registry.ts");
const fileExplorerModule = await import("../../app/e2e/support/helpers/file-explorer.ts");
const isolatedHostDaemonModule =
  await import("../../app/e2e/support/helpers/isolated-host-daemon.ts");
const seedClientModule = await import("../../app/e2e/support/helpers/seed-client.ts");

const { buildSeededHost } = daemonRegistryModule.default ?? daemonRegistryModule;
const { openFileExplorer, openFileFromExplorer } = fileExplorerModule.default ?? fileExplorerModule;
const { startIsolatedHostDaemon } = isolatedHostDaemonModule.default ?? isolatedHostDaemonModule;
const { seedWorkspace } = seedClientModule.default ?? seedClientModule;

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const demoVideo = process.env.E2E_DEMO_VIDEO === "1";
const evidenceDir = demoVideo
  ? path.join(repo, "qa-evidence", "video", "desktop-screenshots")
  : path.join(repo, "qa-evidence", "desktop");
const fixturePath = path.join(repo, "qa-evidence", "fixtures", "csv-preview.csv");

async function pauseForDemo(page, milliseconds = 1_800) {
  if (demoVideo) await page.waitForTimeout(milliseconds);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate Metro port");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const root = await mkdtemp(path.join(os.tmpdir(), "paseo-csv-electron-"));
const metroPort = await availablePort();
process.env.E2E_METRO_PORT = String(metroPort);

let daemon;
let workspace;
let metro;
let desktop;

try {
  daemon = await startIsolatedHostDaemon("srv_csv_desktop", {
    paseoHome: path.join(root, "daemon"),
  });
  process.env.E2E_DAEMON_PORT = String(daemon.port);
  process.env.E2E_SERVER_ID = daemon.serverId;

  const fixtureContent = await readFile(fixturePath, "utf8");
  workspace = await seedWorkspace({
    repoPrefix: "csv-electron-qa-",
    port: daemon.port,
    repo: { files: [{ path: "csv-preview.csv", content: fixtureContent }] },
  });

  const metroLogPath = path.join(root, "metro.log");
  const metroLog = openSync(metroLogPath, "w");
  metro = spawn(
    process.execPath,
    [
      path.join(repo, "node_modules", "expo", "bin", "cli"),
      "start",
      "--web",
      "--port",
      String(metroPort),
      "--offline",
    ],
    {
      cwd: path.join(repo, "packages", "app"),
      env: {
        ...process.env,
        EXPO_NO_DOTENV: "1",
        CI: "1",
        PASEO_WEB_PLATFORM: "electron",
        EXPO_PUBLIC_LOCAL_DAEMON: `127.0.0.1:${daemon.port}`,
      },
      stdio: ["ignore", metroLog, metroLog],
    },
  );
  closeSync(metroLog);
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${metroPort}/status`)).ok;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await warmMetro(metroPort);

  const host = buildSeededHost({
    serverId: daemon.serverId,
    endpoint: `127.0.0.1:${daemon.port}`,
    nowIso: new Date().toISOString(),
  });
  desktop = await electron.launch({
    args: [path.join(repo, "packages", "desktop", "dist", "main.js"), "--no-sandbox"],
    env: {
      ...process.env,
      EXPO_DEV_URL: `http://localhost:${metroPort}`,
      PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
      PASEO_ELECTRON_USER_DATA_DIR: path.join(root, "user-data"),
    },
  });
  await desktop.context().addInitScript((seededHost) => {
    localStorage.setItem("@paseo:e2e", "1");
    localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
    localStorage.removeItem("@paseo:settings");
  }, host);
  const page = await desktop.firstWindow();
  page.on("pageerror", (error) => console.log(`[electron-pageerror] ${error.message}`));
  await page.route(/:(6767|6768)\b/, (route) => route.abort());

  await page.waitForFunction(
    () => {
      const rootElement = document.querySelector("#root");
      return rootElement instanceof HTMLElement && rootElement.childElementCount > 0;
    },
    undefined,
    { timeout: 90_000 },
  );
  if (demoVideo) {
    const visible = await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.show();
      window?.focus();
      return window?.isVisible() ?? false;
    });
    console.log("[electron-qa] demo window visible", visible);
  }
  await page.evaluate((seededHost) => {
    localStorage.setItem("@paseo:e2e", "1");
    localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
    localStorage.removeItem("@paseo:settings");
  }, host);
  console.log(
    "[electron-qa] before route",
    page.url(),
    await page
      .locator("body")
      .innerText()
      .catch(() => "<body unavailable>"),
    await page.evaluate(() => localStorage.getItem("@paseo:daemon-registry")),
  );
  const workspaceRoute = `/h/${daemon.serverId}/workspace/${workspace.workspaceId}`;
  await page.evaluate((route) => {
    history.pushState({}, "", route);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, workspaceRoute);
  await page.waitForTimeout(1_000);
  console.log(
    "[electron-qa] after route",
    page.url(),
    await page
      .locator("body")
      .innerText()
      .catch(() => "<body unavailable>"),
  );
  await expect(page.getByTestId("workspace-tabs-row").first()).toBeVisible({ timeout: 30_000 });
  await openFileExplorer(page);
  await openFileFromExplorer(page, "csv-preview.csv");
  await expect(page.getByTestId("csv-preview")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("csv-ragged-banner")).toBeVisible();
  await pauseForDemo(page, 2_000);
  await page.screenshot({
    path: path.join(evidenceDir, "01-csv-grid-electron-linux.png"),
    fullPage: true,
  });
  if (demoVideo && process.env.E2E_DESKTOP_VIDEO_READY_FILE) {
    await writeFile(process.env.E2E_DESKTOP_VIDEO_READY_FILE, "ready\n");
  }

  if (demoVideo) {
    const search = page.getByTestId("csv-search");
    await search.click();
    for (const term of ["P", "Pa", "Par", "Pari", "Paris"]) {
      await search.fill(term);
      await page.waitForTimeout(140);
    }
    await pauseForDemo(page);
    await page.getByTestId("csv-clear-filters").click();

    await page.getByTestId("csv-sort-1").hover();
    await page.getByTestId("csv-filter-1").click();
    await expect(page.getByTestId("csv-filter-menu-1")).toBeVisible();
    await pauseForDemo(page, 1_200);
    await page.getByTestId("csv-filter-value-1-Active").click({ position: { x: 8, y: 12 } });
    await pauseForDemo(page);

    await page.reload();
    await openFileExplorer(page);
    await openFileFromExplorer(page, "csv-preview.csv");
    await expect(page.getByTestId("csv-preview")).toBeVisible({ timeout: 30_000 });
    await pauseForDemo(page, 1_500);

    await page.getByTestId("csv-sort-2").click({ position: { x: 8, y: 18 } });
    await page.waitForTimeout(250);
    await pauseForDemo(page);

    const grid = page.getByTestId("csv-grid");
    const gridBox = await grid.boundingBox();
    if (!gridBox) throw new Error("CSV grid did not expose measurable bounds");
    await page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height / 2);
    await page.mouse.wheel(320, 0);
    await page.waitForTimeout(250);
    await pauseForDemo(page);
  }

  await page.getByTestId("file-mode-source").click();
  await expect(page.getByTestId("file-source-editor")).toBeVisible({ timeout: 30_000 });
  await pauseForDemo(page);
  await page.screenshot({
    path: path.join(evidenceDir, "02-source-electron-linux.png"),
    fullPage: true,
  });
  await page.getByTestId("file-mode-preview").click();
  await expect(page.getByTestId("csv-preview")).toBeVisible();
  await pauseForDemo(page, 2_000);
  await page.screenshot({
    path: path.join(evidenceDir, "03-preview-round-trip-electron-linux.png"),
    fullPage: true,
  });
  await pauseForDemo(page, 3_000);
  console.log(
    "PASS: real Electron Linux renderer opened the CSV grid and completed Source/Preview round-trip.",
  );
} finally {
  if (desktop) {
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
  if (metro && metro.exitCode === null) metro.kill("SIGTERM");
  await workspace?.cleanup().catch(() => {});
  await daemon?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
