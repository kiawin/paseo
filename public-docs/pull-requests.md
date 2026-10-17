---
title: Pull requests
description: Let agents fix their own pull requests when CI fails, a reviewer comments, or the branch conflicts, and review PRs your teammates ask you to look at or that you opened.
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

The **Review requested** group lists open GitHub PRs where your review is requested, for each project added to Paseo on a host. A PR shows once even when its project is on several hosts. Select **Review** to check the PR out in a new worktree and start a reviewer agent on it. If several hosts have the project, **Review** asks which host runs the reviewer. Each review gets its own worktree, so reviews run side by side.

To review automatically, open the project's settings, choose a **Reviewer**, and turn on either or both:

- **Review automatically when my review is requested**: reviews each request once.
- **Review my own PRs automatically**: reviews each PR you open once, without a review request. This includes PRs your agents open, since they use your `gh` login. GitHub doesn't let anyone request a review from a PR's author, so this is the only way to review those PRs automatically.

The host checks every 3 minutes.

The **Reviewer** is a provider and model, or one of your [agent profiles](/docs/agent-profiles), which also sets the mode, thinking level, and features. Reviewers start with the profile as it is when the review begins, so editing the profile changes later reviews. If you delete the profile, reviews stop until you choose another reviewer. Reviewer agents load the same skills and instructions as any agent of that provider.

**Review again** sets when a reviewer looks at a PR it already reviewed:

- **When my review is requested again** (default): the same reviewer looks at what changed since its last review.
- **On every new commit**: the reviewer looks at each new head as it is pushed, whether or not your review is requested again. This applies to every review in the project, including ones you started by hand. A reviewer you archived is left alone. The review's worktree is archived once the PR merges or closes.

On your own PRs, **On every new commit** stops after **Reviews per PR** reviews, counting the first (3 by default). With **Post reviews to GitHub** and auto-fix both on, a PR goes round in a loop: the reviewer posts, the agent that owns the PR fixes what it found and pushes, and the reviewer looks at the new commit. The limit ends that loop. Your own PR's branch is usually still checked out in its agent's worktree; the reviewer checks out the PR's commit without the branch, so the two don't collide.

Automatic reviews start only for:

- requests made to you directly, not through a team, and PRs you opened;
- PRs from a branch in the same repository, not a fork;
- PRs that aren't drafts.

Everything else is listed for you to review by hand.

By default the reviewer writes its findings in Paseo, and you decide what to post. Turn on **Post reviews to GitHub** to let it post one comment-only review, marked `<!-- paseo-autoreview -->`. A reviewer never approves a PR, requests changes, or pushes commits.

Reviewers treat the PR's title, description, code, and comments as untrusted. A fork PR is never checked out: its reviewer runs in the project's own checkout, reads the PR with `gh pr diff`, and is told not to run any of its code. See [Security](/docs/security) for how Paseo handles untrusted input.

## From the CLI

```bash
paseo agent autofix <agent-id>          # Show the agent's watch
paseo agent autofix <agent-id> on       # Watch the PR on the agent's branch
paseo agent autofix <agent-id> off

paseo project autoreview <project-id> on --provider codex
paseo project autoreview <project-id> on --profile Review   # An agent profile, by name or id
paseo project autoreview <project-id> on --post-reviews
paseo project autoreview <project-id> on --rereview push   # Review every new commit
paseo project autoreview <project-id> off
paseo project autoreview-own <project-id> on --rounds 3   # Review the PRs you open
paseo project autoreview-own <project-id> off
paseo project autofix <project-id> on   # Auto-fix PRs opened by agents
paseo project review <project-id> 42    # Review PR #42 now
```

Agents use the `watch_pull_request` and `unwatch_pull_request` tools; see the [MCP reference](/docs/mcp#pull-requests).
