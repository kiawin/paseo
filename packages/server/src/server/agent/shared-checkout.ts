import { runGitCommand } from "../../utils/run-git-command.js";
import { READ_ONLY_GIT_ENV } from "../checkout-git-utils.js";

const NOT_A_GIT_REPOSITORY_EXIT_CODE = 128;

/**
 * True when cwd is inside a repository's main checkout rather than a linked
 * worktree. Git state is keyed by folder, so a branch switch there changes every
 * workspace on that checkout, and a worktree an agent makes on its own is
 * invisible to Paseo.
 */
export async function isMainGitCheckout(cwd: string): Promise<boolean> {
  const { stdout, exitCode } = await runGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    { cwd, envOverlay: READ_ONLY_GIT_ENV, acceptExitCodes: [0, NOT_A_GIT_REPOSITORY_EXIT_CODE] },
  );
  if (exitCode !== 0) {
    return false;
  }
  const [gitDir, commonDir] = stdout.trim().split("\n");
  return Boolean(gitDir) && gitDir === commonDir;
}

/**
 * Whether move_to_worktree is callable depends on runtime state the daemon can't
 * see at launch (MCP injection, a user-defined `paseo` server, voice and Hub
 * restrictions), so the instruction names both paths and the agent picks by
 * what it actually has.
 */
export function buildSharedCheckoutInstructions(): string {
  return [
    "Paseo: your workspace is a shared local checkout. Other Paseo workspaces and agents can use the same folder, so changing its branch changes their files too.",
    "Do not switch this checkout to another branch, do not run `git worktree add`, and do not use any built-in tool that enters a worktree.",
    "When the task needs its own branch, call `move_to_worktree` from the `paseo` MCP server before you edit files. Search or list your tools for it first, since some clients load MCP tools on demand. Only if it is missing after that check, or it refuses, stop and ask the user to start the task in a new worktree workspace.",
  ].join(" ");
}
