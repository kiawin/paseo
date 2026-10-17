---
title: 拉取请求
description: CI 失败、审查者留下评论或分支出现冲突时，让 Agent 自己修复它的 PR；并审查队友请你看的 PR，以及你自己开的 PR。
nav: 拉取请求
---

# 拉取请求 {#pull-requests}

侧边栏中的 **拉取请求** 页面会列出所有已连接主机上各个工作区的未关闭 PR，以及等待你审查的 PR。你可以在这里为某个 PR 开启自动修复，或启动一个审查 Agent。

PR 自动化运行在 daemon 中，所以关掉 app 后仍会继续工作。它需要主机上的 `gh`（GitHub）或 `glab`（GitLab）已登录。旧版主机需要更新后才能使用。

## 自动修复 {#auto-fix}

在 PR 行上打开 **Auto-fix**，或者交给 Agent 来做：开 PR 的 Agent 可以调用 `watch_pull_request` 工具。之后在以下情况下，Paseo 会给拥有该分支的 Agent 发送提示词：

- PR 头部提交上的 CI 失败。Paseo 会等这个提交的检查全部结束（从第一次失败起最多等 10 分钟），然后把所有失败连同 CI 输出放进一条提示词发送。
- 对仓库有写权限的人（owner、member 或 collaborator）留下了审查或审查评论。仅限 GitHub。
- PR 开始与其基础分支冲突。每个提交只提示一次。

Paseo 从不打断正在进行的轮次。如果 Agent 正忙，提示词会等到这一轮结束再发送。

限制：

- 整台主机同时最多运行 3 个自动轮次，自动审查也算在内。多出来的会排队等待。
- 同一个提交上进行 3 次自动修复轮次后，或连续 3 个提交失败后，监视会暂停。你会收到通知，PR 行也会显示监视已暂停。重新打开自动修复即可重置计数。
- PR 合并或关闭，或者 Agent 被归档，监视就会结束。
- 对从 fork 检出的 PR，监视会暂停，而不会给 Agent 发送提示词。

Agent 在 PR 上发表评论时，会在评论末尾加上 `<!-- paseo-autofix -->`，这样它自己的回复不会再次唤醒它。你和 Agent 使用同一个 `gh` 登录，所以 Paseo 没有其他办法区分你的评论和 Agent 的评论。

### 自动修复智能体创建的 PR {#auto-fix-prs-opened-by-agents}

在项目设置中，**自动修复智能体创建的 PR** 会自动开启自动修复：当项目某个 worktree 中的 Agent 结束一轮时，如果它的分支上有未关闭的 PR，Paseo 就开始监视这个 PR。项目主检出中的 Agent 不算在内；你手动关闭了自动修复的 PR 也会保持关闭。

## 审查请求 {#review-requests}

**Review requested** 分组会为主机上添加到 Paseo 的每个项目，列出请求你审查的未关闭 GitHub PR。即使项目在多台主机上，同一个 PR 也只显示一次。选择 **Review** 会在新的 worktree 中检出该 PR，并在其上启动一个审查 Agent。如果多台主机上都有这个项目，**Review** 会询问由哪台主机运行审查者。每次审查都有自己的 worktree，所以多个审查可以并行运行。

要自动审查，请打开项目设置，选择一个 **审阅者**，然后打开下面一项或两项：

- **有人请求我审阅时自动审阅**：每个请求审查一次。
- **自动审阅我自己的 PR**：你开的每个 PR 都审查一次，不需要审查请求。这也包括你的 Agent 开的 PR，因为它们使用你的 `gh` 登录。GitHub 不允许任何人向 PR 作者请求审查，所以这是自动审查这些 PR 的唯一方式。

主机每 3 分钟检查一次。

**审阅者** 可以是一个 Provider 和模型，也可以是你的某个 [Agent 配置](/docs/agent-profiles)，后者还会设置模式、思考级别和功能。审查者会以审查开始时的配置启动，所以修改配置只影响之后的审查。如果你删除了这个配置，审查会停止，直到你选择另一个审查者。审查 Agent 加载的技能和说明与该 Provider 的其他 Agent 相同。

**再次审查** 决定审查者何时重新查看它已经审查过的 PR：

- **再次请求我的审查时**（默认）：同一个审查者查看自上次审查以来的变更。
- **每次有新提交时**：每推送一个新的头部提交，审查者就查看一次，无论是否再次请求了你的审查。这适用于项目中的所有审查，包括你手动启动的审查。你已归档的审查者不会被唤醒。PR 合并或关闭后，审查的 worktree 会被归档。

在你自己的 PR 上，**每次有新提交时** 会在达到 **每个 PR 的审阅次数**（包括第一次，默认 3 次）后停止。如果 **将审阅发布到 GitHub** 和自动修复都已打开，PR 会进入一个循环：审查者发布审查，拥有该 PR 的 Agent 修复发现的问题并推送，审查者再查看新的提交。这个次数上限会结束该循环。你自己 PR 的分支通常仍检出在其 Agent 的 worktree 中；审查者检出的是 PR 的提交而不是分支，所以两者不会冲突。

只有以下情况会自动开始审查：

- 直接向你发出的请求（不是通过团队），以及你开的 PR；
- 来自同一仓库分支的 PR，而不是来自 fork；
- 不是草稿的 PR。

其他所有 PR 都会列出来，由你手动审查。

默认情况下，审查者把发现写在 Paseo 中，由你决定发布哪些内容。打开 **将审阅发布到 GitHub** 后，审查者可以发布一条审查，并标记为 `<!-- paseo-autoreview -->`。发现 bug、安全问题或没有测试的行为变更时，它会请求修改，否则就批准。批准来自你的 GitHub 登录，所以它和你自己的批准一样计入分支保护规则。在你自己的 PR 上，它只发布评论式审查，因为 GitHub 不允许 PR 作者批准自己的 PR。在 fork PR 上它也只发布评论：是否批准 fork 由你决定。审查者从不推送提交。

**审查说明** 让项目 PR 的每个审查者都遵循你自己的准则，例如要检查什么、可以跳过什么，最多 4000 个字符。Paseo 会把它们放在每条审查提示词中、自己的规则之前。两者冲突时以 Paseo 的规则为准：你的准则不能改变审查的发布方式，也不能关闭下面的不可信输入规则。

审查者会把 PR 的标题、描述、代码和评论都视为不可信内容。fork PR 永远不会被检出：它的审查者在项目自己的检出中运行，用 `gh pr diff` 读取 PR，并被告知不要运行其中的任何代码。关于 Paseo 如何处理不可信输入，参见 [安全](/docs/security)。

## 通过 CLI {#from-the-cli}

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
paseo project review-instructions <project-id> "Check every migration for a rollback."
paseo project review-instructions <project-id> --file review.md
paseo project review-instructions <project-id> --clear
paseo project autofix <project-id> on   # Auto-fix PRs opened by agents
paseo project review <project-id> 42    # Review PR #42 now
```

Agent 使用 `watch_pull_request` 和 `unwatch_pull_request` 工具；参见 [MCP 参考](/docs/mcp#pull-requests)。
