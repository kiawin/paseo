# PR automation

Paseo prompts agents about their pull requests (auto-fix) and starts reviewer agents for PRs that
request your review. The user-facing behavior is in
[public-docs/pull-requests.md](../public-docs/pull-requests.md). This doc covers what the code can't
tell you.

| Piece                            | Owns                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `server/pr-watch/`               | Auto-fix watches: detection, the prompt, dispatch, limits, and the shared turn budget. |
| `server/pr-review/`              | Review requests, reviewer agents, automatic reviews, archiving finished reviews.       |
| Project `prAutomation`           | Per-project settings, on the project record. Machine-local: they start agents.         |
| `server_info.features.prAutoFix` | Gates every RPC in this area.                                                          |

## Polling without a client

Forge PR polling runs only while something registers the workspace with `WorkspaceGitService`.
The app does that while it is open. `PrWatchService` registers each watched cwd itself, so watches
keep polling with no client connected. That costs the same as having the app open on that
workspace.

`PrReviewService` doesn't use workspace polling: review requests aren't tied to a workspace. It
polls `gh pr list --search` per project every 3 minutes, and only for projects with auto-review on.
The app's list request fetches on demand.

## Failure identity

A CI failure is keyed by head commit, workflow name and check name. Don't key on the check-run id:
the batch GraphQL poll reports `databaseId`, `gh pr view` doesn't, and the two disagree for the
same failure. Keying on the id sent the same failure twice in a live run.

## Activity signal for review comments

The GitHub poll carries the PR's `updatedAt`. The service reads the timeline (one GraphQL call)
only when it moves. Don't use `reviewThreads.totalCount`: a reply inside an existing thread doesn't
change it.

Comments count only from `OWNER`, `MEMBER` or `COLLABORATOR`, or a bot on the allowlist in
`pr-watch/detect.ts`. Keep the bot list short: a bot can relay text from anyone who can trigger
it. `authorAssociation` and `authorIsBot` are server-only fields on timeline items; the wire
projection in `checkout-session.ts` strips them.

## The comment marker

The agent posts with the same `gh` login as the user, so "not the viewer" can't separate the
agent's replies from the user's comments. The prompt tells the agent to end every PR comment with
`<!-- paseo-autofix -->`, and comments carrying it are skipped. An agent that forgets the marker
can answer itself until the per-commit cap pauses the watch.

## One budget for automatic turns

Auto-fix turns and automatic reviews share `AutomationTurnBudget` (3 slots). An auto-fix slot is
held from dispatch until the agent's turn ends. An automatic review takes a slot before it creates
the reviewer and hands it to the reviewer agent with `transfer`, not release-then-acquire: a
release wakes the auto-fix queue, which would take the slot in between. Reviews you start by hand
skip the budget.

## Untrusted input

CI output, review comments and PR titles reach agents inside delimited `<untrusted-…>` blocks
(`pr-watch/untrusted.ts`); the closing tag is neutralized inside the text. Fork PRs are never
prompted for auto-fix (the watch pauses) and never reviewed automatically.

A fork PR you review by hand is not checked out. Providers load instructions, settings and hooks
from the working directory (`CLAUDE.md`, `.claude/settings.json`, `AGENTS.md`), so a reviewer
started inside a fork checkout would take orders from the PR before it reads the prompt. The
reviewer runs in the project's own checkout and reads the PR with `gh pr diff`. Such a review
records `ownsWorktree: false`, so the checkout is never archived when the PR ends.

The workspace automation gate (`untrustedSource`) blocks setup scripts in fork worktrees; it
doesn't stop a provider from reading files in them.
