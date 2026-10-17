---
name: paseo-fix-fork-commit
description: Fold a bug fix or tweak into the curated kiawin/paseo fork commit that owns the code, autosquash it, verify the tree, and force-push fork main with a lease. Use when the user says "fix fork commit", "fold this into the fork commit", "include the fix in the existing commit", "amend the fork commit and force push", or "/paseo-fix-fork-commit". This skill rewrites fork history only; it never pushes upstream, never adds a new commit on top of main, and never builds or rolls out a release.
---

# Fold a fix into its Paseo fork commit

The fork `kiawin/paseo` (remote `origin`, branch `main`) keeps each feature as
one curated commit on top of upstream `getpaseo/paseo` (remote `upstream`). A
fix to a fork feature never lands as a new commit. It is folded into the fork
commit that owns the code, and `main` is force-pushed.

The fork-sync process replays the fork commits onto upstream instead of merging,
so `origin/main` is rewritten often, sometimes several times an hour. Every
rewrite gives the same commits new SHAs. That one fact drives most of the
checks below.

## Scope

- Rewrite history on the fork only. Never push to `upstream`. Never push to any
  branch other than `origin/main` unless the user names it.
- Never add the fix as a new commit on `main`.
- Never use `--no-verify`. Fix hook failures instead.
- Never run the full test suite. Run only the test files that changed:
  `npx vitest run <file> --bail=1`.
- Use npm scripts for lint and format: `npm run lint -- <files>`,
  `npm run format:files -- <files>`. Never call the tools directly.
- Never use bare `git stash` or `git stash pop`. The stash stack is shared with
  every worktree and every other session.
- Do not build or roll out a release. When done, point the user to
  `update-paseo` if they want the change deployed.

Save every recorded value below to the session scratchpad directory, in a file
such as `<scratchpad>/fork-fixup.env`, as `NAME=value` lines. Shell variables do
not persist between Bash calls, so start each later command with
`source <scratchpad>/fork-fixup.env`. Write the complete absolute path when you
name it to the user.

## Procedure

### 1. Preflight

Work in a worktree session, never the main checkout. If the current directory is
the main checkout, stop and ask the user to start a worktree session.

```bash
git fetch origin
git fetch upstream
git status --short
git rev-parse HEAD origin/main
git rev-list --left-right --count origin/main...HEAD
```

- The fix must exist as uncommitted changes on a `HEAD` equal to `origin/main`.
  The count must read `0	0`.
- If `HEAD` is behind or diverged (left count above 0), stop and report. Another
  session may have moved `main`. Do not rebase the user's work onto it without
  asking.
- If `HEAD` is ahead, list those commits with `git log --oneline origin/main..HEAD`
  and ask the user how to handle them. Do not reset them away.
- Trust the count, not `git log --oneline`. A branch made before a sync holds
  the same subjects under dead SHAs and looks identical to `origin/main`. A fix
  committed there never reaches a build.
- If the bug was seen on another branch or lineage, confirm it exists on
  `origin/main` before fixing it. Damage in one lineage says nothing about the
  other:

  ```bash
  git show origin/main:<path> | diff - <(git show <other-branch>:<path>)
  ```

  If `origin/main` is already correct, there is nothing to fold. Tell the user.

Record the lease value and the upstream base:

```bash
ORIGIN_MAIN=$(git rev-parse origin/main)
UPSTREAM_BASE=$(git merge-base origin/main upstream/main)
git log --oneline --reverse "$UPSTREAM_BASE"..origin/main   # the fork commits
```

### 2. Map each change to its owning commit

For every modified, deleted, or new file:

```bash
git status --short
git log --oneline -1 "$UPSTREAM_BASE"..origin/main -- <file>
```

- The result is the fork commit that last touched the file. That is the default
  owner.
- An empty result means the file is upstream-only or new. A new file goes to the
  fork commit that owns the feature it belongs to. An edit to an upstream-only
  file goes to the fork commit whose behavior forces the edit.
- The last toucher is not always the owner. `git log -S` and blame name the
  last commit that changed a string, not the one at fault when upstream or
  another fork commit also touched it. When two fork commits touch the file,
  bisect the blob across the fork commits. The commit where the count first
  goes wrong owns the fix:

  ```bash
  for c in $(git rev-list --reverse "$UPSTREAM_BASE"..origin/main); do
    echo "$(git log --oneline -1 "$c") :: $(git show "$c":<path> 2>/dev/null | grep -c '<token>')"
  done
  ```

- A fork feature can break an upstream file it never touched, such as an
  upstream test assertion. Blame points at upstream, but the fix folds into the
  fork commit that changed the behavior.
- If one file holds hunks for different commits, ask the user before splitting
  it. `git add -p` needs an interactive terminal, so write each part as a patch
  and stage it with `git apply --cached <part>.patch`. Commit a partly staged
  file with `git commit --fixup=<sha>` and no paths: a path-limited commit takes
  the whole working-tree file and ignores the index.

### 3. Check dependencies before choosing a target

A change can use code that only a later fork commit adds, such as a hook,
helper, type, i18n key, or setting. For each target, check the identifiers the
change uses against the target commit's version of each file:

```bash
git show <target-sha>:<path> | grep -n '<identifier>'
git log --oneline -S '<identifier>' "$UPSTREAM_BASE"..origin/main
```

- If the change uses something that first appears in a later commit, the change
  folds into that later commit. Folding it earlier breaks the intermediate commit
  and conflicts on replay.
- When changes split across two or more commits, show the user the mapping
  before any rewrite:

  | File | Target commit | Reason |
  | ---- | ------------- | ------ |

  Wait for the user to confirm the mapping when it splits or moves a change
  away from its default owner.

### 4. Back up

```bash
git branch backup/pre-fixup-<topic>-<YYYYMMDD> HEAD
```

Use today's date. The backup is the pre-fixup tip, equal to `ORIGIN_MAIN`. The
uncommitted fix is not in it; step 5 records the fixup tip for that.

### 5. Make one path-limited fixup commit per target

Check that no Spec Kit block is about to be staged:

```bash
git diff -- <paths> | grep -nE '<!-- SPECKIT (START|END) -->'
```

Any match: leave that block out of the commit and keep the file's other edits.

For each target, oldest first:

```bash
git add <paths>
git diff --cached | grep -nE '<!-- SPECKIT (START|END) -->'   # must print nothing
git commit --fixup=<target-sha> -- <paths>
```

- The lefthook pre-commit hook runs `format:check`, `lint` and `typecheck`. Let
  it run.
- On a format failure, run `npm run format:files -- <paths>`, re-add, and commit
  again. On a lint or typecheck failure, fix the code. Never pass `--no-verify`.
- If typecheck fails in a package that consumes another workspace's
  declarations, run `npm ci` and `npm run build:server` before diagnosing. A
  sync brings new dependencies and RPCs, and stale `dist` declarations produce
  dozens of phantom errors.
- If the hook fails in code the fix does not touch, the tip may already be
  broken. Syncs have left resurrected i18n keys, phantom imports, and
  incomplete exhaustive records on `main`. Confirm on the unmodified
  `origin/main` before blaming the fix, and report the defect to the user.
- If a test file changed, run it: `npx vitest run <file> --bail=1`.

When all fixups exist, `git status --short` must be clean for the fix paths.
Record the fixup tip:

```bash
FIXUP_TIP=$(git rev-parse HEAD)
```

### 6. Record the expected tree

```bash
EXPECTED_TREE=$(git rev-parse 'HEAD^{tree}')
```

Save `ORIGIN_MAIN`, `UPSTREAM_BASE`, `FIXUP_TIP`, `EXPECTED_TREE`, the backup
branch name, and every target SHA to the scratchpad file.

### 7. Autosquash

The rebase base is the parent of the oldest target commit:

```bash
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <oldest-target-sha>^
```

- `GIT_SEQUENCE_EDITOR=:` accepts the generated todo list, which makes the
  interactive rebase non-interactive. This harness cannot drive an editor.
- On a conflict, stop. Report the conflicting paths and the commit being
  replayed. Do not run `git rebase --abort`, `--skip`, or resolve it without the
  user. Leave the backup branch in place.
- Auto mode may deny the rebase as `[Git Destructive]`. It has both denied and
  allowed this exact command, so do not plan around either outcome; the backup
  branch makes both safe. If it is denied, print the exact command and ask the
  user to approve it by name or run it with `!`. Do not work around the denial.

### 8. Verify

```bash
test "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_TREE" && echo TREE_OK
git log --oneline "$UPSTREAM_BASE"..HEAD | grep -E 'fixup!' && echo FIXUP_LEFT
git range-diff "$ORIGIN_MAIN"...HEAD
```

- The tree must match byte for byte. If it differs, stop and report.
- No `fixup!` commit may remain.
- In `range-diff`, only the target commits may show `!`. Every other commit must
  show `=`.

Show where each file landed:

```bash
git show --stat <new-sha>   # once per rewritten target commit
```

### 9. Push with a lease

Fetch, check, and push in one command. `main` can move between separate calls.

```bash
git fetch origin &&
  test "$(git rev-parse origin/main)" = "$ORIGIN_MAIN" &&
  git push --force-with-lease=main:"$ORIGIN_MAIN" origin HEAD:main
```

- Push only to `main`, only with the lease pinned to the recorded SHA.
- If auto mode denies the push as `[Git Destructive]`, do not work around it.
  Print the exact command with the SHA expanded and ask the user to approve the
  force push by name, such as "I approve the force push", or run it with `!`.
  A bare "yes" or "I approve" has been denied before; do not retry after one.

If `origin/main` moved since step 1, do not push. Never `git rebase origin/main`:
it replays the old-SHA duplicates of every fork commit. Replay only the fixup
commits onto the new main, then redo the checks:

```bash
NEW_MAIN=$(git rev-parse origin/main)
git switch -c fixup-replay-<YYYYMMDD> "$FIXUP_TIP"
git rebase --onto "$NEW_MAIN" "$ORIGIN_MAIN"
```

- Autosquash matches `fixup!` commits by subject, so the replay works when
  upstream sync gave the targets new SHAs. Confirm every target subject still
  exists on the new main.
- Rerun step 3 against the new target SHAs. The new main may have changed the
  code the fix depends on.
- Set `ORIGIN_MAIN=$NEW_MAIN`, record a new `EXPECTED_TREE` from the replayed
  fixup tip, then redo steps 7, 8 and 9.

### 10. Report

Give the user:

1. A table of every fold:

   | Fix | Folded into (old SHA) | New SHA |
   | --- | --------------------- | ------- |

   Also list commits above the targets whose SHA changed with unchanged content.

2. The checks that ran: the pre-commit hook jobs, each targeted test file, the
   tree comparison, and `range-diff`.
3. The checks that did not run, such as the app, the e2e specs, or the full test
   suite.
4. The backup branch name.
5. The `origin/main` move: old SHA to new SHA.
6. This note: anyone whose local `main` is based on the old SHA must reset it to
   `origin/main`.
7. To deploy the change, run `update-paseo`.
