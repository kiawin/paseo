import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { createIdleAgent } from "../support/helpers/archive-tab";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { createTempGitRepo } from "../support/helpers/workspace";

// A worktree cut outside Paseo's private root is left on disk by archive, and
// removing it is a separate explicit act. That is the only destructive path a
// person can trigger from the UI, so it is covered end to end against a real
// daemon rather than through the removal helper alone.
test.describe("Worktree removal from history", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let worktreeClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdProjectIds = new Set<string>();

  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectSeedClient();
    worktreeClient = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-remove-");
  });

  test.afterEach(async () => {
    for (const projectId of createdProjectIds) {
      await worktreeClient.removeProject(projectId).catch(() => undefined);
    }
    createdProjectIds.clear();
    await worktreeClient.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    await tempRepo.cleanup().catch(() => undefined);
  });

  function gitWorktreeList(repoPath: string): string {
    return execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf8" });
  }

  async function seedArchivedSiblingWorktree(page: Page) {
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    await worktreeClient.setProjectWorktreeLocation(project.projectId, { mode: "sibling" });

    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `remove-${randomUUID().slice(0, 8)}`,
    });
    createdProjectIds.add(worktree.projectKey);

    // Sibling puts the worktree next to the repository, not under Paseo's root.
    expect(dirname(worktree.workspaceDirectory)).toBe(`${tempRepo.path}-worktrees`);

    const agent = await createIdleAgent(client, {
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      title: `remove-${randomUUID().slice(0, 8)}`,
    });

    await archiveWorkspaceFromDaemon(worktreeClient, worktree.workspaceDirectory);

    // The whole point of the non-managed policy: archive does not delete this.
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);
    expect(gitWorktreeList(tempRepo.path)).toContain(worktree.workspaceDirectory);

    // Straight to the archived workspace: the sessions list would first need the
    // agent record un-archived, which is a different lifecycle from the one
    // under test here.
    const workspaceRoute = buildHostWorkspaceRoute(getServerId(), worktree.workspaceId);
    await page.goto(`${workspaceRoute}?open=${encodeURIComponent(`agent:${agent.id}`)}`);
    await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    return { agent, worktree };
  }

  test("archive leaves a sibling worktree on disk and history offers to remove it", async ({
    page,
  }) => {
    const seeded = await seedArchivedSiblingWorktree(page);

    // The path is the only thing that tells someone which directory goes away.
    await expect(page.getByTestId("workspace-recovery-worktree-path")).toContainText(
      seeded.worktree.workspaceDirectory,
    );

    const remove = page.getByTestId("workspace-recovery-remove-worktree");
    await expect(remove).toBeVisible();

    // Declining the confirmation must leave the directory alone.
    page.once("dialog", (dialog) => void dialog.dismiss());
    await remove.click();
    await expect
      .poll(() => existsSync(seeded.worktree.workspaceDirectory), { timeout: 10_000 })
      .toBe(true);

    page.once("dialog", (dialog) => void dialog.accept());
    await remove.click();

    await expect
      .poll(() => existsSync(seeded.worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);
    // Removed through git, so the repository must not still list it.
    expect(gitWorktreeList(tempRepo.path)).not.toContain(seeded.worktree.workspaceDirectory);
  });

  test("git refusing a dirty worktree surfaces the refusal and keeps the directory", async ({
    page,
  }) => {
    const seeded = await seedArchivedSiblingWorktree(page);

    // Uncommitted work is exactly what `git worktree remove` without --force
    // refuses, and that refusal is the guarantee the non-managed policy rests on.
    execFileSync("git", ["checkout", "-b", "dirty-check"], {
      cwd: seeded.worktree.workspaceDirectory,
    });
    execFileSync("sh", ["-c", "echo uncommitted > tracked-change.txt"], {
      cwd: seeded.worktree.workspaceDirectory,
    });
    execFileSync("git", ["add", "tracked-change.txt"], {
      cwd: seeded.worktree.workspaceDirectory,
    });

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("workspace-recovery-remove-worktree").click();

    // The refusal is reported as a toast; git's own reason is what reaches it.
    await expect(page.getByTestId("app-toast-message")).toContainText(/git|worktree/i, {
      timeout: 30_000,
    });
    expect(existsSync(seeded.worktree.workspaceDirectory)).toBe(true);
    expect(gitWorktreeList(tempRepo.path)).toContain(seeded.worktree.workspaceDirectory);
  });
});
