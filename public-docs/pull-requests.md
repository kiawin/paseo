---
title: Pull requests
description: Let agents fix their own pull requests when CI fails, a reviewer comments, or the branch conflicts, and review PRs your teammates ask you to look at.
nav: Pull requests
order: 13
category: Workspaces
---

# Pull requests

The **Pull requests** screen in the sidebar lists open PRs from your workspaces on every connected host, and the PRs waiting for your review. From there you can turn on auto-fix for a PR, or start a reviewer agent.

Pull request automation runs in the daemon, so it keeps working with the app closed. It needs the host's `gh` (GitHub) or `glab` (GitLab) to be signed in. Update older hosts to use it.

## Auto-fix

Turn on **Auto-fix** on a PR row, or let the agent do it: an agent that opens a PR can call the `watch_pull_request` tool. Paseo then prompts the agent that owns the branch when:

- CI fails on the PR's head commit. Paseo waits for the commit's checks to finish (at most 10 minutes after the first failure) and sends every failure in one prompt, with the CI output.
- Someone with write access to the repository (owner, member, or collaborator) leaves a review or review comment. GitHub only.
- The PR starts conflicting with its base branch. Once per commit.

Paseo never interrupts a turn. If the agent is busy, the prompt waits until the turn ends.

Limits:

- At most 3 automatic turns run at once across the host, including automatic reviews. More wait their turn.
- A watch pauses after 3 auto-fix turns on one commit, or after 3 failing commits in a row. You get a notification, and the row shows the watch as paused. Turn auto-fix on again to reset the count.
- A merged or closed PR, or an archived agent, ends the watch.
- Watches on PRs checked out from a fork pause instead of prompting the agent.

When the agent posts a comment on the PR, it ends the comment with `<!-- paseo-autofix -->`, so its own replies don't wake it again. You and the agent use the same `gh` login, so Paseo can't tell your comments from the agent's any other way.

### Auto-fix PRs opened by agents

In a project's settings, **Auto-fix PRs opened by agents** turns auto-fix on by itself: when an agent in one of the project's worktrees ends a turn with an open PR on its branch, Paseo starts watching that PR. Agents in the project's main checkout don't count, and a PR you turned auto-fix off for stays off.

## Review requests

The **Review requested** group lists open GitHub PRs where your review is requested, for each project added to Paseo on a host. Select **Review** to check the PR out in a new worktree and start a reviewer agent on it. Each review gets its own worktree, so reviews run side by side.

To review automatically, open the project's settings, choose a **Reviewer** provider, and turn on **Review automatically when my review is requested**. The host checks every 3 minutes. It reviews each request once; when someone requests your review again, the same reviewer looks at what changed. The review's worktree is archived once the PR merges or closes.

Automatic reviews start only for:

- requests made to you directly, not through a team;
- PRs from a branch in the same repository, not a fork;
- PRs that aren't drafts.

Everything else is listed for you to review by hand.

By default the reviewer writes its findings in Paseo, and you decide what to post. Turn on **Post reviews to GitHub** to let it post one comment-only review, marked `<!-- paseo-autoreview -->`. A reviewer never approves a PR, requests changes, or pushes commits.

Reviewers treat the PR's description, code, and comments as untrusted. On a fork PR, the reviewer is told not to run any of its code. See [Security](/docs/security) for how Paseo handles untrusted input.

## From the CLI

```bash
paseo agent autofix <agent-id>          # Show the agent's watch
paseo agent autofix <agent-id> on       # Watch the PR on the agent's branch
paseo agent autofix <agent-id> off

paseo project autoreview <project-id> on --provider codex
paseo project autoreview <project-id> on --post-reviews
paseo project autoreview <project-id> off
paseo project autofix <project-id> on   # Auto-fix PRs opened by agents
```

Agents use the `watch_pull_request` and `unwatch_pull_request` tools; see the [MCP reference](/docs/mcp#pull-requests).
