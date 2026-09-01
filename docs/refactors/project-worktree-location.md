# Project-level worktree location

Goal: let each project choose where its Paseo-managed worktrees are cut — `managed`, `sibling`, `nested`, or `custom` — from the project settings screen. Today the location is one daemon-global setting with a fixed layout.

Status: designed, not started. Branch `feat/project-worktree-location`, based on `upstream/main` at `0c38749c3`.

Staged implementation plan: [project-worktree-location-plan.md](project-worktree-location-plan.md). It also records four corrections to this document found while tracing the code — two extra path-shape sites in `checkout-git.ts`, a delete guard that checks containment rather than ownership, the layer the ownership policy belongs in, and a two-store split in the settings UI.

## Today

Every Paseo worktree lands at `<base>/<repoHash8>/<slug>`:

- `resolvePaseoWorktreesBaseRoot()` (`packages/server/src/utils/worktree.ts:853`) returns `worktrees.root` from `$PASEO_HOME/config.json` if set, else `$PASEO_HOME/worktrees`. Tilde is expanded; a relative value resolves against `PASEO_HOME`, not the repo.
- `deriveWorktreeProjectHash()` (`worktree.ts:841`) hashes the repo root from `git rev-parse --git-common-dir` into 8 base36 chars.
- `computeWorktreePath()` (`worktree.ts:877`) joins the three.

The only knob is `worktrees.root` — `WorktreesConfigSchema` at `packages/server/src/server/persisted-config.ts:84`, resolved by `resolveWorktreesRoot` at `config.ts:487`. It has no UI, no CLI, and no RPC: you hand-edit `config.json`. It is not in `MutableDaemonConfigSchema` (`daemon-config-store.ts:19`), so `daemon.config.reload` reports it under `restartRequiredPaths` and the daemon keeps the boot-time value until restart. Setting it relocates the base only — the `<hash>/<slug>` layout under it is hardcoded, and it applies to every project at once.

Worktree directories from other tools are easy to mistake for Paseo's. `.claude/worktrees/<name>` is Claude Code's `EnterWorktree`; a hand-made or Orca-made `../<repo>-worktrees/<slug>` is neither. Paseo only ever writes under its own base root.

## Where the setting lives

Machine-local, on the project record. **Not `paseo.json`.**

`paseo.json` is committed, so anyone with commit access can change it, and archive _deletes_ the worktree directory. A committed `custom` root would be an attacker-controlled delete target. Separately, `paseo.json` is read from inside the worktree after creation (`worktree.ts:643`), so using it to decide where the worktree goes is circular.

Concretely:

- `PersistedProjectRecordSchema` (`packages/server/src/server/workspace-registry.ts:14`) gains the field, alongside `customName` and `customIconRevision`.
- `WorkspaceProjectDescriptorPayloadSchema` (`packages/protocol/src/messages.ts:3952`) surfaces it, optional, with a `COMPAT(projectWorktreeLocation)` tag.
- New RPC pair `project.worktree.location.set.request` / `.response`, following [docs/rpc-namespacing.md](../rpc-namespacing.md). `ProjectRenameRequestSchema` (`messages.ts:966`) is the shape to copy.
- UI goes in the existing **Worktree** section of `packages/app/src/screens/project-settings-screen.tsx:694`, which today holds only setup and teardown.

## Schema

```ts
export const WorktreeLocationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("managed") }),
  z.object({ mode: z.literal("sibling") }),
  z.object({ mode: z.literal("nested") }),
  z.object({ mode: z.literal("custom"), root: z.string().min(1) }),
]);
```

Absent or null means `managed`. The wire field stays optional and is never narrowed — see [docs/protocol-compatibility.md](../protocol-compatibility.md).

## Resolution

One function resolves the directory that holds slugs, replacing the `paseoHome` / `worktreesRoot` pair threaded through creation today:

| mode      | directory that holds slugs                           |
| --------- | ---------------------------------------------------- |
| `managed` | `<base>/<hash8>` — unchanged                         |
| `sibling` | `<dirname(repoRoot)>/<basename(repoRoot)>-worktrees` |
| `nested`  | `<repoRoot>/.worktrees`                              |
| `custom`  | `expandTilde(root)`, absolute required               |

The worktree is that directory plus `/<slug>`.

`managed` carries a two-level `<hash>/<slug>` suffix under the base; the other three carry one level. That asymmetry is what breaks ownership below.

## Ownership: the part that carries the risk

`isPaseoOwnedWorktreeCwd` (`worktree.ts:932`) proves ownership from path shape alone, and the comment says why:

> The `<hash>/<slug>` prefix is Paseo-private — nothing else writes there — so the path shape alone is sufficient proof of ownership, even when git has already forgotten about the worktree.

`.worktrees/` and `../<repo>-worktrees/` are not Paseo-private; they are where people put hand-made worktrees. Under the three new modes, path shape stops being proof, and archive would delete worktrees Paseo did not create.

The marker to replace it already exists. Every Paseo worktree gets `<worktreeGitDir>/paseo/worktree.json`, written at creation (`worktree.ts:1253`, path from `worktree-metadata.ts:160`). It lives in the per-worktree git admin dir, so it never appears as an untracked file.

Replace the single check with three tiers, first hit wins:

1. **Registry.** A workspace record with `isPaseoOwnedWorktree === true` (`workspace-registry.ts:78`) and a matching `worktreeRoot` (`:69`). Both are already persisted, and archive already passes a per-backing `paseoWorktreesRoot` (`workspace-archive-service.ts:406`).
2. **Marker.** `worktree.json` present for that worktree.
3. **Path shape.** Kept, but only for `managed`.

A non-managed path with no record and no marker is not owned. Leave the directory and report it rather than deleting something unknown.

Call sites to update:

| Site                                                                                      | What it gates            |
| ----------------------------------------------------------------------------------------- | ------------------------ |
| `packages/server/src/server/workspace-archive-service.ts:306`                             | archive                  |
| `packages/server/src/server/agent/create-agent-lifecycle-dispatch.ts:193`                 | agent-owned workspace    |
| `packages/server/src/server/auto-archive-on-merge/archive-if-safe.ts:72`                  | auto-archive after merge |
| `packages/server/src/server/session/workspace-recovery/workspace-recovery-service.ts:178` | recovery                 |
| `packages/server/src/server/worktree/commands.ts:127`                                     | CLI worktree archive     |
| `packages/server/src/utils/checkout-git.ts:1168`                                          | checkout guard           |
| `packages/server/src/utils/worktree.ts:1097`                                              | delete (internal)        |

`checkout-git.ts:1061` calls `resolvePaseoWorktreesBaseRoot` for a descendant check and needs the same treatment.

## `nested` needs a git exclude

`<repoRoot>/.worktrees` sits inside the repo and shows up as untracked. Write `.worktrees/` to `.git/info/exclude` when the first nested worktree is created. Do not edit the repo's `.gitignore` — the choice is local, and the file is committed.

## Decisions already made

- **A `custom` root claimed by another project is rejected.** Two projects sharing one root would collide on slug. Appending a hash under `custom` would work but defeats the point of naming an explicit path.
- **Changing the mode does not migrate existing worktrees.** Their absolute paths are already persisted per workspace, so they keep resolving; only new worktrees use the new mode. Say so inline in the settings row.

## Work order

Ownership first — it carries the risk, and the UI is mechanical once resolution is settled.

1. `WorktreeLocationSchema` in protocol; field on the project descriptor; regenerate inbound validation (see [docs/protocol-validation.md](../protocol-validation.md)).
2. Resolution function in `worktree.ts`, with the four modes and the `managed` path unchanged.
3. Three-tier ownership, plus the seven call sites and the descendant check.
4. Field on `PersistedProjectRecordSchema` and the registry read/write path.
5. RPC pair and its session handler.
6. Creation threading: `worktree-core.ts`, `worktree-session.ts`, `create-agent-lifecycle-dispatch.ts`.
7. `.git/info/exclude` write for `nested`.
8. Settings UI and i18n strings.

Roughly 20-25 files.

## Verification

- Unit: resolution for all four modes, including a repo root with a trailing separator and a `custom` root under a symlink.
- Unit: ownership refuses a hand-made worktree sitting in `.worktrees/` and in a sibling directory.
- Integration: create then archive in each mode, and confirm archive leaves an unowned neighbour directory alone.
- Per [docs/testing.md](../testing.md), run only the specs you touch.
