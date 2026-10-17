# PR automation

Paseo prompts agents about their pull requests (auto-fix) and starts reviewer agents for PRs that
request your review or that you opened. The user-facing behavior is in
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
polls `gh pr list --search` per project every 3 minutes, and only for projects with `autoReview` or
`autoReviewOwn` on. The app's list request fetches on demand. The same poll follows up on every
active review: it archives reviews whose PR ended and, for projects with `reReviewOn: "push"`,
prompts the reviewer when the head moved past `reviewedHeadSha`. A push re-review leaves
`requestActive` alone: the PR isn't back in your queue, and marking it would make a later real
re-request look already handled.

## Your own PRs

Agents open PRs with the user's `gh` login, and GitHub refuses a review request to a PR's author, so
these PRs never reach the request queue. `autoReviewOwn` adds a second search, `author:@me`, and
records those reviews with `origin: "own"`. An open PR of yours counts as requested on every poll;
dropping it from `stillRequested` would clear `requestActive` and review it again on the next poll.

With posting and auto-fix both on, each posted review wakes the author agent, its fix push makes a
new head, and push mode reviews that head. Auto-fix's limits don't stop this: `attemptsForHead`
resets on every head, and `consecutiveFailedHeads` counts only CI failures. `reviewRounds` on the
review record stops push re-reviews of `origin: "own"` reviews at `maxOwnReviewRounds` (default 3).
Reviews you were asked for aren't capped: a person drives those re-reviews. A review posted
before the author agent's watch starts predates the watch's `review.since` and doesn't reach the
agent. Auto-watch starts when the turn that opened the PR ends, minutes before a review lands.

The PR's branch is usually still checked out in the author agent's worktree, and git refuses to
check one branch out twice. The first checkout fetches `refs/pull/N/head` into a branch with a new
name (`feature-1`). The re-review prompt moves the worktree with a detached checkout of
`pull/N/head`, not `gh pr checkout`, which tries the original branch name.

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

Reviews a reviewer posts carry `<!-- paseo-autoreview -->` instead, and auto-fix doesn't skip
them: that is how a reviewer's findings reach the agent that owns the PR. Findings stay on GitHub
rather than going straight to the agent, so they get the same trust check, de-duplication and
busy-agent queue as any review, and you see them on the PR.

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
