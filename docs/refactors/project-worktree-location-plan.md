# Project-level worktree location — implementation plan

Staged plan for [project-worktree-location.md](project-worktree-location.md). Read the design doc first; this file only says how to land it.

Baseline: branch `feat/project-worktree-location`, `upstream/main` at `0c38749c3`. `npm ci` + `npm run build:server` + `npm run typecheck` verified green in this worktree before any edit.

Reviewed by two independent agents (`codex/gpt-5.6-sol`, `opencode-go/glm-5.3`). Every claim was re-verified against code; where the reviewers disagreed, the adjudication is inline.

Every stage ends green on `npm run typecheck`, `npm run lint`, and the specs named in that stage.

**The feature activates in stage 6.** That is the first point at which a non-managed worktree can exist on disk, so listing, recovery, deletion policy, and the git exclude must all land at or before stage 6.

## The deletion model

The design doc assumes every mode behaves like `managed`: archive removes the worktree directory. That assumption is what made ownership hard, because `managed` proves ownership from path shape — `<base>/<hash8>/<slug>` is Paseo-private, so location _is_ the credential. `sibling`, `nested`, and `custom` are shared namespaces where people keep their own worktrees, so location proves nothing there.

Rather than invent a replacement credential, this plan uses one git already enforces.

**Two questions, not one.** Today a single `isPaseoOwnedWorktree` boolean answers both:

- **(a) Did Paseo create this workspace?** Governs lifecycle — auto-archive, teardown. Getting it wrong archives a record, which is reversible.
- **(b) May Paseo delete this directory?** Irreversible.

`managed` makes them the same fact. The new modes split them, and the plan splits the code accordingly.

**Deletion policy is fixed at creation, never read from the project's current mode.** The design doc says changing the mode does not migrate existing worktrees — their absolute paths stay put. So mode is mutable while placement is not, and deriving policy from the live project record reintroduces the exact hazard Option C exists to remove:

```
1. project mode = custom     → worktree created at ~/shared-wt/feat-x
2. project mode → managed
3. archive that old worktree → policy resolved from current mode = managed
                             → --force, swallowed failure, unconditional rm -rf
                             → recursive delete on a shared-namespace path
```

Persist the deletion class on the workspace record at creation and treat it as immutable. `PersistedWorkspaceRecordSchema` (`workspace-registry.ts:47-79`) persists `worktreeRoot`, `isPaseoOwnedWorktree`, and `mainRepoRoot` but **no placement class** — that is the new field. The project's `worktreeLocation` governs where the _next_ worktree is cut and nothing else.

**The persisted field cannot be the sole authority.** Zod strips unknown keys, and `upsert` / `archiveIfPresent` (`workspace-registry.ts:247`) re-parse the whole record and write it back — so a daemon that predates the field deletes it on any mutation. See [Rollout](#rollout). Resolve the policy from both, taking the safe side:

```
placement = record.worktreePlacement
         ?? (worktreePath is under <managed base>/<hash>/ ? "managed" : "git-validated")
```

Path shape decides only the `managed` case, which is the private namespace where it is sound proof. Anything outside that namespace falls to `git-validated`, so a lost field can never select the destructive policy.

**Deletion policy per mode:**

| Mode                            | On archive                    | Explicit "remove worktree" action   |
| ------------------------------- | ----------------------------- | ----------------------------------- |
| `managed`                       | removes directory (unchanged) | n/a                                 |
| `sibling` / `nested` / `custom` | **leaves directory**          | `git worktree remove`, no `--force` |

Not-owned is not an error state — `workspace-archive-service.ts:355` already returns early for it, and that is the normal path for `local_checkout` and `directory` workspaces every day.

**What `git worktree remove` actually guards.** Tested against git directly:

| Scenario                          | `git worktree remove` (no `--force`)          | Data                           |
| --------------------------------- | --------------------------------------------- | ------------------------------ |
| Untracked non-ignored files       | `fatal: contains modified or untracked files` | safe                           |
| Plain directory, not a worktree   | `fatal: is not a working tree`                | survives                       |
| Worktree of a _different_ repo    | `fatal: is not a working tree`                | survives                       |
| Clean tree, only gitignored files | succeeds                                      | `.env`, `node_modules` deleted |

Git's worktree registry is bound to the actual directory and to _this_ repo, so most stale-record cases fail closed: a re-occupied path that is a plain directory, or a worktree of another repo, is refused outright.

**Call it what it is: a repository-membership and cleanliness guard, not an ownership guard.** It does not prove Paseo authorship, and one stale-record case still passes:

1. **Same-repo path reuse.** If a stale path is re-occupied by a _clean, human-created worktree of the same repo_, `git worktree remove` succeeds. Git cannot tell it from Paseo's own.
2. **Ignored content is deleted silently.** `.env`, `node_modules`, build caches, local databases, ignored nested repositories, and anything excluded via a global exclude or `.git/info/exclude`. Material here: worktree setup runs `npm install` and seeds `.env`.

Two further behaviours are refusals rather than destruction, and need tests so they surface as clean errors: a **locked** worktree, and one containing **submodules**, can both remain undeletable.

Residual risk: case 1, removed by an explicit user action. Everything but ignored content is recoverable — `git worktree remove` touches no branches or commits. The confirmation UI must show the resolved path and say that Paseo cannot prove it created the directory.

**`managed` keeps its current mechanics.** `worktree.ts:1122-1135` runs `git worktree remove --force`, swallows the failure, then removes the directory unconditionally. For `managed` that is intended, not a bug: archive means the worktree is done, and the unconditional remove is what keeps archive idempotent when a half-finished prior attempt already took the admin dir. It is safe there because the namespace is private. Do not change it.

Non-managed gives up **one** part of that, not all of it. The retry loop does two jobs, and only the second is lost:

| Job                                                                                                   | Kept?                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Retry through transient contention — locked file, watcher, open handle; delays `[0,100,300,700,1500]` | **Yes.** Wrap the same loop around `git worktree remove` instead of `rm`. |
| Finish a terminal orphan, where git has disowned the directory                                        | **No.**                                                                   |

The orphan state is one git cannot recover from at any force level. Verified directly — with the admin dir removed and the working tree left behind:

```
git worktree remove ../wt          → fatal: '../wt' is not a working tree  (128)
git worktree remove --force ../wt  → fatal: '../wt' is not a working tree  (128)
git worktree prune && retry        → fatal: '../wt' is not a working tree  (128)
```

Neither `--force` nor `prune` helps; only a raw recursive delete finishes the job, which is exactly why the fallback exists for `managed`. Reaching the state needs a partial failure _between_ git dropping the admin entry and finishing the working tree — a locked file, a process with its cwd inside, a moved repo root. Unlikely on Linux and macOS, plausible on Windows.

For non-managed the consequence is that such a directory can never be removed by Paseo, and git's own message (`is not a working tree`) does not tell the user what to do. Stage 3 and stage 7 therefore require the archive-time report to name the full path. See [Deferred](#deferred) for the bounded cleanup we are deliberately not building yet.

## Corrections to the design doc

Four findings from tracing the code. Both reviewers confirmed all four.

### 1. Two more path-shape assumptions in `checkout-git.ts`

- `checkout-git.ts:1164` — `getPaseoWorktreeForCwd` fast-path rejects anything not matching `/[\\/]worktrees[\\/]/`. No new mode matches: `nested` is `/.worktrees/` (preceded by `.`), `sibling` is `-worktrees/` (preceded by `-`), `custom` is arbitrary.

  **Already a bug today**, independent of this feature: setting the daemon-global `worktrees.root` to a path with no `worktrees` segment (say `/srv/paseo-wt`) makes every worktree fail the fast path. Fix it as a bug.

- `checkout-git.ts:1063` — `isPaseoWorktreePath`'s no-options fallback, `/[/\\]\.paseo[/\\]worktrees[/\\]/`. Its only caller is `getMainRepoRootFromCommonDir` (`:1039`), and `getMainRepoRoot` has no non-test callers. **Dead in production — delete rather than port.**

`getPaseoWorktreeForCwd` feeds `getStoredBaseRefForCwd` (`:1200`) and `inspectCheckoutContext` (`:1730`, surfaced via `getCheckoutSnapshotFacts` at `:1958`), so under the new modes base-ref reads and `facts.paseoWorktree` silently report "not a Paseo worktree".

### 2. `deletePaseoWorktree`'s guard is containment, not ownership

`worktree.ts:1097` computes ownership but uses it only to pick a path; the refusal at `:1108` is containment in `resolvedWorktreesRoot`. Under `managed`, containment _is_ ownership. Under the new modes the holder is shared, so it is not. Option C resolves this by replacing the guard with git's verdict for non-managed, rather than strengthening the ownership proof.

### 3. Ownership needs the registry, but lives in a leaf util

`isPaseoOwnedWorktreeCwd` is in `utils/worktree.ts`, which has no registry access and should not gain one. `archive-if-safe.ts:40` already injects it, so the seam exists.

Note the first draft of this plan contradicted itself here — it put policy in `server/` and then listed `utils/worktree.ts:1097` as a caller, reversing server→utils. Resolution: `deletePaseoWorktree` takes a resolved policy argument and never reconstructs authority.

### 4. The settings UI spans two stores

The Worktree section (`project-settings-screen.tsx:694`) is `paseo.json`-backed: `draft` / `applyDraftToConfig` / `saveMutation` with a `PaseoConfigRevision` and `stale_project_config` handling (`:498`, `:687-689`). The location is machine-local on the project record and cannot join `draft`.

### Note on the registry flag

`isPaseoOwnedWorktree` on the workspace record is **derived from the path-shape check**, not from provisioning — `status-projection.ts:70` sets it from the git snapshot, which comes from `getPaseoWorktreeForCwd`. So the design doc's "tier 1: registry" was never independent evidence; it is the path check, cached. Under Option C this matters less, but the flag must be written at creation for non-managed modes, since there is no path shape to derive it from.

> **Reviewer disagreement, adjudicated.** Sol held that registry-tier ownership could authorize deleting a directory Paseo did not create; GLM held it was not constructible because the flag is only written by Paseo provisioning. GLM's premise is wrong twice: `archive()` is a _soft_ archive (`workspace-registry.ts:247` sets `archivedAt`, keeps the row), so records outlive their directories; and the flag is derived from path shape, not provisioning. **Sol was correct.** Option C removes the concern by not relying on that evidence for deletion at all.

## Sites both the design doc and this plan's first draft missed

**`listPaseoWorktrees` (`worktree.ts:1037-1058`).** Derives `getPaseoWorktreesRoot` (`<base>/<hash>`) and filters `git worktree list` by containment at `:1054`. Under every non-managed mode it matches nothing. Consumers: `WorkspaceGitService.listWorktrees` (`workspace-git-service.ts:842-856`) → CLI/app worktree list (`worktree/commands.ts:26-34`, `worktree-session.ts:421`) and archive-by-branch resolution (`commands.ts:194-201`).

**Recovery is a creation site, not just an ownership site.** `workspace-recovery-service.ts:189-196` calls `createWorktree` with `worktreesRoot: deps.worktreesRoot`. For a non-managed project the restored worktree lands under `<base>/<hash>`, then the divergence check at `:208` fails and restore errors out.

**No stage adds the `server_info` feature flag.** The UI gates via `useHostFeature`, but nothing adds `projectWorktreeLocation` to the features object (`messages.ts:3356+`; precedent at `:3484`) or advertises it (`websocket-server.ts:1632-1643`).

**Creation threading is wider than four files.** Also `agent/tools/paseo-tools.ts:1308-1321` (has `projectId`), `agent/create-agent/create.ts:536-548` (**cwd only, no `projectId`**), `create-agent-lifecycle-dispatch.ts:124`, `checkout-session.ts:778`. The cwd-only entry point is the gap: resolve location inside `createWorktreeCore` via an injected `resolveWorktreeLocation(projectId | repoRoot)`.

**`nested` breaks the file watcher, not just `git status`.** `loadIgnoredDirs` (`workspace-git-service.ts:2588-2613`) uses `--exclude-standard`, so until `.worktrees/` is excluded the main workspace's recursive watcher descends into a second full checkout — inotify cost plus events attributed to the wrong workspace. The exclude write is a correctness prerequisite of nested creation. See [file-observation.md](../file-observation.md).

**Collision validation is asymmetric.** The design only rejects a `custom` root claimed by another project. Also needed: `sibling`/`nested` holders colliding with another project's `custom` root; two custom paths resolving to one directory through symlinks; a custom root that is an _ancestor_ of `repoRoot`; a `sibling` holder that already exists as its own git repo. Resolve the candidate holder for every mode and compare symmetrically, realpath-aware.

## Stages

### Stage 1 — protocol schema

- `WorktreeLocationSchema` in `packages/protocol/src/messages.ts`. Discriminated union, no `.transform()`/`.catch()`/`.preprocess()` — wire schemas stay pure per [protocol-compatibility.md](../protocol-compatibility.md).
- Optional `projectWorktreeLocation` on `WorkspaceProjectDescriptorPayloadSchema` (`:3952`), tagged `// COMPAT(projectWorktreeLocation): added in vX, remove optional after <date>`.
- Optional `removeWorktreeDirectory: z.boolean()` on `ArchiveWorkspaceRequestSchema` (`:2499`), same COMPAT tag. Semantics: ignored for `managed` (which always removes); for non-managed, `true` requests the git-validated removal. Absent means leave the directory — so an old client archiving a non-managed workspace gets the safe behaviour.
- Optional `projectWorktreeLocation: z.boolean()` on the `server_info` features object (`:3356+`).
- Regenerate inbound validation: `npm run -w @getpaseo/protocol generate:validators`. See [protocol-validation.md](../protocol-validation.md).
- `npm run build:protocol && npm run build:client`.

### Stage 2 — resolution

`resolveWorktreeHolderDir({ repoRoot, location, paseoHome, worktreesBaseRoot })` in `utils/worktree.ts`, four modes per the design table. `managed` must be byte-identical to today's `getPaseoWorktreesRoot` — that is the regression bar.

`computeWorktreePath` (`:877`) has **no callers anywhere in the repo**. Delete it.

Shape-level `custom` validation here (expand tilde, require absolute, reject ancestor-of-`repoRoot`). Cross-project collision needs the registry and lives at the RPC boundary in stage 5.

Specs: `worktree.test.ts`, `worktree.posix.test.ts` (symlink, trailing separator).

### Stage 3 — deletion policy

Independently valuable and landable: it changes no existing behaviour, only adds the second policy.

`deletePaseoWorktree` takes an explicit policy instead of reconstructing authority:

```ts
type WorktreeDeletionPolicy =
  | { kind: "managed" } // current mechanics, unchanged
  | { kind: "git-validated"; force?: boolean };
```

- `managed` — `git worktree remove --force`, swallow, `removeDirectoryWithRetries`, `prune`. Byte-for-byte today's path (`worktree.ts:1122-1146`).
- `git-validated` — `git worktree remove` **without** `--force`, retried on the existing `[0,100,300,700,1500]` delays so transient contention still clears. When the retries are exhausted, throw a typed error carrying git's stderr and the resolved path; **do not** fall through to `removeDirectoryWithRetries`. `prune` after success only. `force: true` is reachable only from a second explicit user confirmation.

The retry loop moves rather than disappears: today it wraps the recursive delete, here it wraps the git command. Only the terminal-orphan recovery is given up.

The typed error must carry the resolved path, not just git's message — the workspace record is already archived by the time this surfaces, so the archive-time report is the user's only notice of where the directory is.

The containment check stays as a backstop under both.

Specs: git-validated refuses a plain directory, a foreign repo's worktree, and a dirty worktree, and leaves each on disk; the retry loop clears a transient failure; the thrown error carries the resolved path; managed path unchanged; `force` escalation removes a dirty worktree.

### Stage 4 — lifecycle vs deletion split

New `packages/server/src/server/worktree/ownership.ts` holding the composed policy; `utils/worktree.ts` keeps only the path-shape primitive.

- **Lifecycle authority (a)** — "Paseo created this workspace". **Persisted provenance on the workspace record is authoritative.** Marker and path-shape checks recover legacy records only; a missing or corrupt marker must never disable auto-archive, teardown, recovery, or git facts for a workspace whose record says Paseo created it. Being wrong is reversible.
- **Deletion policy (b)** — from the **placement class persisted on the workspace record at creation**, never from the project's current mode. `managed` → `{kind:"managed"}`; non-managed → `{kind:"git-validated"}`, and only when the request asked for it; otherwise no deletion.

New field on `PersistedWorkspaceRecordSchema` (`workspace-registry.ts:47-79`) carrying the placement class, written at creation, immutable thereafter. Absent on pre-existing records — they are all `managed`, so absence resolves to `{kind:"managed"}`, which is the current behaviour.

`archive-if-safe.ts:77` currently early-returns on `!ownership.allowed`, which would silently disable auto-archive-on-merge for every non-managed mode. Point it at (a), not (b), so the record still archives; it never requests directory removal.

Write `isPaseoOwnedWorktree: true` on the record at creation for non-managed modes — there is no path shape to derive it from (see the note above).

Call sites: the seven from the design doc, plus `checkout-git.ts:1061` (descendant check), `:1164` (fast path — drop it, or check against the known holder set; no string pre-filter can cover arbitrary custom roots), and `:1063` (delete as dead code).

Specs: auto-archive still fires for a non-managed workspace and leaves the directory; archive without `removeWorktreeDirectory` leaves the directory; a hand-made worktree in `.worktrees/` is never targeted by an archive of a neighbouring workspace; **a worktree created under `custom` still resolves `{kind:"git-validated"}` after the project is switched to `managed`**; a record with no placement class resolves `{kind:"managed"}`.

### Stage 5 — persistence and RPC

- `worktreeLocation` on `PersistedProjectRecordSchema` (`workspace-registry.ts:14`), nullable + optional + `.transform(v => v ?? null)`, matching `customName`.
- Surface on the **project** descriptor: `session.ts:5126-5140`, `workspace-directory.ts:567-575`. (`session.ts:4869` and `:4958` build `WorkspaceDescriptorPayload`, a different schema — include only if stage 1 also adds the field there.)
- `project.worktree.location.set.request` / `.response` per [rpc-namespacing.md](../rpc-namespacing.md). Copy `ProjectRenameRequestSchema` (`messages.ts:966`) and `handleProjectRenameRequest` (`session.ts:3010`).
- Wiring: `messages.ts` (schemas, union entries, types) → `authorization/operation-permissions.ts` (both directions → `workspace.manage`) → `session.ts` (dispatch + handler) → `client/daemon-client.ts` (typed method).
- Symmetric collision validation in the handler.
- Thread `removeWorktreeDirectory` from the archive request into `ArchiveByScopeRequest` (`workspace-archive-service.ts:72`) and on to `maybeRemoveDirectory` (`:348`).

**A second RPC for the retry-with-force path.** The archive request's boolean covers the first, unforced attempt only. Once it fails the record is already archived, and `requireActiveWorkspaceForArchive` (`workspace-archive-service.ts:81`) resolves against `listActiveWorkspaces()` — so re-sending an archive request throws `Workspace not found`. The "Remove anyway" affordance has no reachable operation without a new one.

Add `workspace.worktree.remove.request` / `.response`: takes the archived `workspaceId`, resolves the backing path from the archived record, requires an explicit `force` flag, and is gated on the same capability. Do **not** overload a repeated archive request — archive already happened, and re-running it would re-run teardown.

Do not advertise the feature here. See stage 6.

### Stage 6 — activation

Everything that must hold before a non-managed worktree can exist:

- Creation threading: `worktree-core.ts`, `worktree-session.ts`, `create-agent-lifecycle-dispatch.ts`, `worktree/commands.ts:211`, `agent/tools/paseo-tools.ts:1308`, `agent/create-agent/create.ts:536`, `checkout-session.ts:778` — via an injected `resolveWorktreeLocation` so cwd-only entry points work.
- `listPaseoWorktrees` filters against the resolved holder.
- `recreateArchivedWorktree` resolves the holder from `workspace.projectId`.
- `.git/info/exclude` write for `nested`, at or before first nested creation. Resolve the **git common dir**, not `<repoRoot>/.git` — bare repos and linked worktrees do not have `.git` there. Idempotent read-modify-write. Never touch `.gitignore`.
- Remove `getPaseoWorktreesRoot` and the `paseoHome`/`worktreesRoot` pair once the last caller is converted. [coding-standards.md](../coding-standards.md) requires migrating all callers in the same refactor.
- **Advertise `features.projectWorktreeLocation` here** (`websocket-server.ts:1632-1643`), not in stage 5. Creation, listing, recovery, and nested exclusion do not work until this stage, so advertising earlier would claim a capability the daemon cannot honour.

Specs: `worktree-core.posix.test.ts`, `worktree-session.test.ts`, `paseo-worktree-service.test.ts`, `resolve-worktree-creation-intent.test.ts`, plus listing and recovery in each mode.

### Stage 7 — UI

Two surfaces: the location control, and the explicit removal affordance.

**Location control.** Reads the project descriptor, writes through the RPC — not through `draft`/`saveMutation`.

- New `SettingsSection` at the top of the Worktree `SettingsGroup` (`project-settings-screen.tsx:694`), above Setup.
- Canonical settings choice row: `settingsStyles.row` + `rowContent` (`rowTitle` + `rowHint`) with a `DropdownMenu` trigger. `ToolCallDetailRow` (`settings/appearance/appearance-section.tsx:307`) is the shape to copy; `DropdownMenu*` is already imported at `:18-23`.
- `custom` reveals a path `TextInput`, committing on blur/submit.
- Gate on `features.projectWorktreeLocation` via `useHostFeature` (`:38`; precedent `projectCustomIcon` at `:232`). One gate, no fallback.

**Removal affordance.** On archive of a non-managed workspace, offer "also remove the worktree directory", default off. Copy must state that ignored files go too — `node_modules`, `.env`. On git's refusal, surface its message and offer the `force` escalation as a distinct second confirmation, never a retry button.

i18n for four modes, custom-path label, validation errors, the no-migration note, the removal checkbox, and the refusal/force copy.

#### Wireframe

Collapsed, default `managed`. Location is new; Setup and Teardown unchanged.

```
┌ Worktree ──────────────────────────────────────────────────────────┐
│ How Paseo creates worktrees for this project.                      │
│                                                                    │
│ LOCATION                                                           │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Worktree location                              ┌─────────────┐ │ │
│ │ Where new worktrees are created.               │ Managed   ▾ │ │ │
│ │                                                └─────────────┘ │ │
│ │ ~/.paseo/worktrees/a1b2c3d4/<name>                             │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ ⓘ Changing this does not move existing worktrees. They stay    │ │
│ │   where they are; only new ones use the new location.          │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│ SETUP                                            [Worktree docs ↗] │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ npm install                                                    │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│ TEARDOWN                                         [Worktree docs ↗] │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ docker compose down                                            │ │
│ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

Dropdown open. The resolved-path line previews the selection against this project's root, so the modes are legible without docs.

```
                                       ┌──────────────────────────────┐
                                       │ ✓ Managed                    │
                                       │   Paseo's own directory      │
                                       │ ──────────────────────────── │
                                       │   Sibling                    │
                                       │   Next to the repo           │
                                       │ ──────────────────────────── │
                                       │   Nested                     │
                                       │   Inside the repo            │
                                       │ ──────────────────────────── │
                                       │   Custom…                    │
                                       │   A path you choose          │
                                       └──────────────────────────────┘
```

`custom` selected — path row appears. Error state shown; the same row renders the collision rejection from stage 5.

```
│ LOCATION                                                           │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Worktree location                              ┌─────────────┐ │ │
│ │ Where new worktrees are created.               │ Custom    ▾ │ │ │
│ │                                                └─────────────┘ │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ Path                                                           │ │
│ │ ┌────────────────────────────────────────────────────────────┐ │ │
│ │ │ ~/code/worktrees                                           │ │ │
│ │ └────────────────────────────────────────────────────────────┘ │ │
│ │ ⚠ Already used by another project.                             │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ ⓘ Changing this does not move existing worktrees. …            │ │
│ └────────────────────────────────────────────────────────────────┘ │
```

The section has **no Save button**: it writes through the RPC on change, while the screen's existing Save button keeps owning only the `paseo.json` draft below it. Two save models in one group is the trap; the resolved-path preview and the immediate write are what stop it reading as unsaved.

Archive dialog, non-managed workspace. Unchecked by default; `managed` never shows this row.

```
┌ Archive workspace ─────────────────────────────────────────────────┐
│ feat-x                                                             │
│ ~/code/myrepo-worktrees/feat-x                                     │
│                                                                    │
│ ☐ Also remove the worktree directory                               │
│   Deletes ignored files too, including node_modules and .env.      │
│                                                                    │
│                                        [ Cancel ]  [ Archive ]     │
└────────────────────────────────────────────────────────────────────┘
```

Git refused, recoverably. Its message is shown verbatim; `force` is a separate decision, not a retry. The full path is always shown — the workspace record is already archived, so this dialog is the user's only notice of where the directory is.

```
┌ Worktree not removed ──────────────────────────────────────────────┐
│ Workspace archived. The directory is still on disk.                │
│                                                                    │
│ ~/code/myrepo-worktrees/feat-x                                     │
│                                                                    │
│ git: contains modified or untracked files, use --force to delete   │
│                                                                    │
│                       [ Leave it ]  [ Remove anyway… ]             │
└────────────────────────────────────────────────────────────────────┘
```

Git refused, **terminally** — `is not a working tree`. Neither `--force` nor `prune` recovers this, so there is no "Remove anyway": offering one would promise something the code cannot do. Give the user a copyable command instead.

```
┌ Worktree not removed ──────────────────────────────────────────────┐
│ Workspace archived. Git no longer recognises this directory, so    │
│ Paseo cannot remove it.                                            │
│                                                                    │
│ ~/code/myrepo-worktrees/feat-x                                     │
│                                                                    │
│ Remove it yourself:                                                │
│   rm -rf ~/code/myrepo-worktrees/feat-x                       [⧉]  │
│                                                                    │
│                                                    [ Dismiss ]     │
└────────────────────────────────────────────────────────────────────┘
```

Distinguish the two by git's exit message: `is not a working tree` is terminal, `contains modified or untracked files` is not. Do not show the force affordance for the terminal case. A locked worktree and one containing submodules are further refusals — surface git's message rather than inventing copy.

Two requirements on these dialogs:

- **Shell-quote the path in the copyable command.** A `custom` root is arbitrary user input; interpolating it raw into `rm -rf …` breaks on spaces and is a command-injection footgun on anything worse.
- **Persist the failure, don't rely on the dialog.** The record is already archived, so a dismissed dialog strands the user with no way back to the path. Store the failed-removal state and path on the archived record and surface it in archived-workspace UI.

The recoverable dialog's confirmation must also state that Paseo cannot prove it created the directory — git verifies repo membership and cleanliness, not authorship.

### Stage 8 — docs

- [architecture.md](../architecture.md) or a new subject doc owns the resolution table and the deletion model.
- [agent-lifecycle.md](../agent-lifecycle.md) — archive semantics now differ by mode.
- [file-observation.md](../file-observation.md) gains the `nested` exclude requirement.
- [glossary.md](../glossary.md) if the modes get user-facing labels.
- Delete both `docs/refactors/project-worktree-location*.md` when the work lands.

## Verification

Per [testing.md](../testing.md), run only the specs touched. Never the full suite locally.

Unit:

- Resolution for all four modes; trailing separator; `custom` under a symlink; `managed` byte-identical to today.
- `git-validated` deletion refuses a plain directory, a foreign repo's worktree, a dirty worktree, a locked worktree, and one containing submodules — leaving each on disk.
- A worktree created under `custom` still resolves `{kind:"git-validated"}` after the project switches to `managed`.
- Placement fallback: a record with **no** placement class resolves `{kind:"managed"}` when its path is under `<base>/<hash>/`, and `{kind:"git-validated"}` when it is not. Simulate the downgrade round-trip — strip the field from a non-managed record, re-resolve, assert it does **not** become `managed`.
- Same-repo path reuse: a clean human-made worktree of the same repo at a stale record's path **is** removed — assert the known gap so it cannot regress silently into an unnoticed one.
- An ignored nested repository under the worktree is destroyed by removal — assert it, and make sure the UI copy covers it.
- `managed` deletion mechanics unchanged.
- Archive without `removeWorktreeDirectory` leaves a non-managed directory on disk.
- Auto-archive-on-merge still fires for a non-managed workspace.

Integration:

- Create, list, archive in each of the four modes.
- Archive with removal requested, on a clean non-managed worktree, removes it.
- A hand-made worktree in the same holder dir survives archive of its neighbour.
- A `managed` worktree created before the change still lists and archives after it.
- Recovery restores a non-managed worktree to its own holder.
- `nested` creation excludes `.worktrees/` and the main workspace watcher does not descend into it.

Protocol pairing, per [protocol-compatibility.md](../protocol-compatibility.md): old-client/new-daemon — absent `removeWorktreeDirectory` means leave the directory. New-client/old-daemon — the client must gate sending the field on the advertised capability; without that gate the safe default is not guaranteed. Test both directions explicitly.

Manual, per [qa.md](../qa.md): the settings row on compact and wide form factors; the archive dialog, both refusal paths, and the force retry through its own RPC; a `custom` path containing spaces, rendered into the copyable command.

## Decisions taken

- **Non-managed modes do not delete on archive.** Removal is an explicit, opt-in action. This is what removes the need for a worktree-marker identity scheme, which the earlier draft of this plan required.
- **Git's verdict is authoritative for non-managed removal.** No `rm -rf` fallback there; a refusal leaves the directory and reports why. Retries are kept — they move from wrapping the delete to wrapping the git command.
- **`managed` is untouched.** Its forceful, self-healing delete is intended behaviour in a private namespace, not a bug to fix in this refactor.
- **Placement class is immutable and lives on the workspace record.** The project's `worktreeLocation` decides where the next worktree is cut; it never re-classifies an existing one. Deriving deletion policy from the live project mode would let a mode change point managed semantics at a shared-namespace path.
- **Git is a membership and cleanliness guard, not an ownership guard.** Same-repo path reuse and ignored content are known, accepted gaps, asserted in tests and stated in the confirmation copy.

## Rollout

**Nothing to migrate.** Every project at rollout has no `worktreeLocation` (→ `managed`), every workspace has no placement class, and every existing worktree is physically under `<base>/<hash>/<slug>`. Both defaults land on `managed`, which is today's behaviour. Per [data-model.md](../data-model.md) there are no migrations; readers fall back.

**Users who set the global `worktrees.root` are unaffected.** `managed` means "Paseo's base root", whatever that root is — the `<hash>/<slug>` layout under it is unchanged. Note their worktrees are already mishandled by the `checkout-git.ts:1164` fast path today (see corrections, item 1); this refactor fixes that as a side effect.

**Daemon downgrade is the one real hazard.** Zod strips unknown keys and the registry re-parses records on every mutation, so a daemon predating the placement field erases it:

```
1. new daemon → worktree at ~/shared-wt/feat-x, record: worktreePlacement = "git-validated"
2. daemon downgraded (beta → stable, desktop rollback)
3. any mutation — archive, rename, label, pin — re-parses and writes back without the field
4. daemon upgraded again
5. record has no placement class
```

Without the path-derived fallback above, step 5 resolves to `managed` and the next archive runs `--force` plus an unconditional recursive delete against a shared-namespace path. **The fallback is what makes downgrade survivable**, so it is a correctness requirement, not defensive padding.

The same reasoning applies to the project record's `worktreeLocation`: a downgrade erases it and the project silently reverts to cutting new worktrees under the managed root. That direction is merely surprising, not destructive — but say so in the release notes.

**Selecting `nested` on a repo that already has `.worktrees/`.** People keep hand-made worktrees there. Treat an already-populated holder as the same validation class as a colliding `custom` root: warn on selection, and never reuse an existing directory as a slug target. The `.git/info/exclude` write is additive and idempotent, so it is safe on a repo that already excludes the path.

**No daemon restart.** The old global `worktrees.root` sits outside `MutableDaemonConfigSchema` (`daemon-config-store.ts:19`), so changing it lands in `restartRequiredPaths` and needs a restart. The per-project setting lives on the project record and is read at creation time, so it takes effect immediately. Worth calling out in the release notes — it is the main practical improvement over the global knob.

## Deferred

**Bounded orphan cleanup.** If a non-managed worktree reaches the terminal state above, nothing in this plan can remove it — by design, since the only mechanism that could is the raw recursive delete Option C exists to avoid.

An earlier draft of this section proposed a four-condition test — path inside the holder, a matching registry record, absent from `git worktree list`, not a worktree of any repo — and claimed it proved a Paseo leftover by elimination. **That test is unsafe and the claim was wrong.** A stale archived record, a deleted original directory, and a later plain-directory replacement satisfy all four conditions, and a raw delete would destroy the replacement. It is the same stale-record hazard Option C was built to avoid, reappearing one layer down.

Path shape plus registry evidence cannot distinguish a Paseo leftover from an unrelated directory at the same path. Nothing short of an immutable creation identity written into the directory can, which is the marker-identity scheme this plan deliberately dropped.

So bounded cleanup stays manual until someone is willing to pay for that identity. **Not building it now:** the state has not been observed, and the archive-time report gives the user the exact path. Revisit if it shows up in practice — most likely on Windows, where open handles make the partial failure plausible.
