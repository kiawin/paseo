import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const cleanupDaemons = new Set<TestPaseoDaemon>();
const cleanupClients = new Set<DaemonClient>();
const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(cleanupClients, (client) => client.close().catch(() => undefined)));
  cleanupClients.clear();
  await Promise.all(Array.from(cleanupDaemons, (daemon) => daemon.close().catch(() => undefined)));
  cleanupDaemons.clear();
  for (const target of cleanupPaths) rmSync(target, { recursive: true, force: true });
  cleanupPaths.clear();
});

async function connectedClient(): Promise<DaemonClient> {
  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(client);
  await client.connect();
  return client;
}

test("advertises PR auto-fix and answers its list and set requests", async () => {
  const client = await connectedClient();

  expect(client.getLastServerInfoMessage()?.features?.prAutoFix).toBe(true);
  expect(await client.listAgentPrWatches()).toEqual([]);
  await expect(client.setAgentPrWatch("missing-agent", true)).rejects.toThrow(
    "Agent missing-agent not found or archived",
  );
  expect(await client.setAgentPrWatch("missing-agent", false)).toBeNull();
}, 60_000);

test("answers project PR automation and review request RPCs", async () => {
  const client = await connectedClient();
  const settings = {
    autoReview: true,
    reviewProvider: null,
    postReviews: false,
    autoFixAgentPullRequests: false,
  };

  await expect(client.setProjectPrAutomation("missing-project", settings)).rejects.toThrow(
    "Choose a reviewer provider",
  );
  await expect(
    client.setProjectPrAutomation("missing-project", { ...settings, reviewProvider: "codex" }),
  ).rejects.toThrow("Project not found");
  await expect(
    client.setProjectPrAutomation("missing-project", {
      ...settings,
      reviewProvider: "codex",
      reReviewOn: "always",
    }),
  ).rejects.toThrow("Unknown re-review option");
  expect(await client.listReviewRequests()).toEqual({ reviewRequests: [], errors: [] });
  await expect(client.startPrReview({ projectId: "missing-project", prNumber: 1 })).rejects.toThrow(
    "Project not found",
  );
}, 60_000);

async function addGitProject(client: DaemonClient): Promise<string> {
  const repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-pr-automation-")));
  cleanupPaths.add(repoRoot);
  execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
  writeFileSync(path.join(repoRoot, "README.md"), "# repo\n", "utf8");
  execSync("git add README.md", { cwd: repoRoot, stdio: "pipe" });
  execSync(
    "git -c user.email=test@getpaseo.dev -c user.name=Test -c commit.gpgSign=false commit -m initial",
    { cwd: repoRoot, stdio: "pipe" },
  );
  return (await client.addProject(repoRoot)).project!.projectId;
}

test("keeps review instructions an older app doesn't send, and clears them on an empty string", async () => {
  const client = await connectedClient();
  expect(client.getLastServerInfoMessage()?.features?.prReviewInstructions).toBe(true);
  const projectId = await addGitProject(client);
  const settings = {
    autoReview: false,
    reviewProvider: "codex",
    postReviews: false,
    autoFixAgentPullRequests: false,
  };

  await client.setProjectPrAutomation(projectId, {
    ...settings,
    reviewInstructions: " Check migrations. ",
  });
  const kept = await client.setProjectPrAutomation(projectId, { ...settings, postReviews: true });
  expect(kept.reviewInstructions).toBe("Check migrations.");

  const cleared = await client.setProjectPrAutomation(projectId, {
    ...settings,
    reviewInstructions: "",
  });
  expect(cleared).not.toHaveProperty("reviewInstructions");
}, 60_000);

test("keeps own-PR review settings when an older app saves the project's settings", async () => {
  const client = await connectedClient();
  expect(client.getLastServerInfoMessage()?.features?.prAutoReviewOwn).toBe(true);
  const projectId = await addGitProject(client);
  const settings = {
    autoReview: false,
    reviewProvider: "codex",
    postReviews: true,
    autoFixAgentPullRequests: true,
  };

  await expect(
    client.setProjectPrAutomation(projectId, { ...settings, maxOwnReviewRounds: 0 }),
  ).rejects.toThrow("Review rounds must be a whole number from 1 to 10");
  await client.setProjectPrAutomation(projectId, {
    ...settings,
    autoReviewOwn: true,
    maxOwnReviewRounds: 5,
  });
  // An app from before own-PR reviews sends only the fields it knows.
  const saved = await client.setProjectPrAutomation(projectId, { ...settings, postReviews: false });

  expect(saved).toMatchObject({ postReviews: false, autoReviewOwn: true, maxOwnReviewRounds: 5 });
  const { projects } = await client.listProjects();
  expect(projects.find((project) => project.projectId === projectId)?.projectPrAutomation).toEqual(
    saved,
  );
}, 60_000);
