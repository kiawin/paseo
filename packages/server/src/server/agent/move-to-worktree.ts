import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitCommand } from "../../utils/run-git-command.js";

/**
 * Uncommitted work captured from a checkout without modifying it, as git objects.
 * `git stash create` records tracked changes and a scratch index records untracked
 * files, so the working tree, index, and stash list of the shared checkout stay
 * untouched, and later edits by other agents there don't leak into the copy.
 */
export interface CapturedUncommittedChanges {
  stashCommit: string | null;
  untrackedTree: string | null;
}

export interface MoveToWorktreePromptInput {
  history: string;
  task: string;
  sourceCwd: string;
  worktreeCwd: string;
  branchName: string;
  baseBranch: string;
  carriedChanges: CapturedUncommittedChanges | null;
}

export async function resolveCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await runGitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  const branch = stdout.trim();
  if (!branch) {
    throw new Error(
      `The checkout at ${cwd} is on a detached HEAD, so there is no branch to branch off. Ask the user how to continue.`,
    );
  }
  return branch;
}

export async function captureUncommittedChanges(cwd: string): Promise<CapturedUncommittedChanges> {
  const sourceRoot = (await runGitCommand(["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  const stashCommit =
    (await runGitCommand(["stash", "create"], { cwd: sourceRoot })).stdout.trim() || null;
  const untrackedPaths = (
    await runGitCommand(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: sourceRoot })
  ).stdout;
  const untrackedTree =
    untrackedPaths.length > 0
      ? await withScratchIndex(async (envOverlay) => {
          await runGitCommand(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            cwd: sourceRoot,
            input: untrackedPaths,
            envOverlay: { ...envOverlay, GIT_LITERAL_PATHSPECS: "1" },
          });
          return (
            await runGitCommand(["write-tree"], { cwd: sourceRoot, envOverlay })
          ).stdout.trim();
        })
      : null;
  return { stashCommit, untrackedTree };
}

/**
 * Writes captured changes into a fresh worktree. Worktrees share the object
 * database, so the unreferenced stash commit and tree resolve here. The source
 * checkout is never touched.
 */
export async function applyCapturedChanges(
  changes: CapturedUncommittedChanges,
  worktreeRoot: string,
): Promise<void> {
  if (changes.stashCommit) {
    await runGitCommand(["stash", "apply", changes.stashCommit], { cwd: worktreeRoot });
  }
  const untrackedTree = changes.untrackedTree;
  if (untrackedTree) {
    // checkout-index from a scratch index writes the files (symlinks verbatim)
    // without staging them. Untracked paths can't collide with tracked files, so
    // --force only replaces files Paseo seeded from the checkout, such as an
    // untracked paseo.json; the captured copy is the one to keep.
    await withScratchIndex(async (envOverlay) => {
      await runGitCommand(["read-tree", untrackedTree], { cwd: worktreeRoot, envOverlay });
      await runGitCommand(["checkout-index", "--all", "--force"], {
        cwd: worktreeRoot,
        envOverlay,
      });
    });
  }
}

export function hasCapturedChanges(changes: CapturedUncommittedChanges): boolean {
  return changes.stashCommit !== null || changes.untrackedTree !== null;
}

async function withScratchIndex<T>(
  operation: (envOverlay: { GIT_INDEX_FILE: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-move-to-worktree-"));
  try {
    return await operation({ GIT_INDEX_FILE: join(dir, "index") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function buildMoveToWorktreePrompt(input: MoveToWorktreePromptInput): string {
  const changesLine =
    input.carriedChanges && hasCapturedChanges(input.carriedChanges)
      ? "- Uncommitted changes from the shared checkout were copied here. The originals are still in the shared checkout; leave them there."
      : "- No uncommitted changes were copied from the shared checkout.";
  return [
    input.history,
    "",
    `You are taking over the task above. The previous agent moved it out of the shared checkout at ${input.sourceCwd} into a Paseo worktree:`,
    `- Worktree: ${input.worktreeCwd}`,
    `- Branch: ${input.branchName}, created from ${input.baseBranch}`,
    changesLine,
    "Work only in this worktree.",
    "",
    "Task:",
    input.task,
  ].join("\n");
}
