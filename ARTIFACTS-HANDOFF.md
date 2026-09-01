# Handoff: Artifacts feature for Paseo

Scratch document for picking up this work in a fresh session. Not intended to be committed.
Delete before opening a PR.

## Branch state

- Worktree: `~/Projects/github/paseo-worktrees/artifacts-tab`, branch `feat/artifacts-tab`
- Base: `de635ffd7` = local `main` = `origin/main` (fork, 2026-08-28), version `0.7.0`
- Missing one upstream commit: `0c38749c3 fix(server): rewind paginated Codex threads (#4119)`.
  Rebase onto `upstream/main` if that matters.
- The fork carries commits upstream does not. One is load-bearing for this feature — see
  **Transport** below.

## What the feature is

An **Artifacts** surface in the Explorer sidebar listing HTML deliverables agents produce
(reports, dashboards, diagrams, summaries), viewable rendered rather than read as source.

Two sources:

1. **Local** — any provider writes an artifact through a new `publish_artifact` Paseo tool.
2. **Claude artifacts** — Claude Code's built-in `Artifact` tool publishes to claude.ai and
   returns a URL. Paseo records provenance ("agent X in workspace Y published URL Z"). These
   are links Paseo witnessed, not files it owns. They must open **externally**, never inside
   the privileged viewer.

Motivating need: non-Claude agents (Codex, Copilot, OpenCode, Pi) have no way to hand back a
rendered deliverable today. Related: issue #3561, discussions #2915, #3444, #3428.

## Verified facts (all re-checked at 0.7.0 unless noted)

### Placement — the Explorer, not "a tab beside Changes and Files"

`#3826` (`c914bcb44`) deleted `docs/side-panel.md`, replaced it with `docs/explorer-sidebar.md`,
and dissolved `workspace-tabs/side-panel.ts`. `SIDE_PANEL_TAB_KINDS` no longer exists.

Two surfaces now:

| Surface          | What it is                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Explorer sidebar | Docked outside the workspace split canvas, own persisted width, Cmd+E toggle, cannot be split. Selecting a tab does not change workspace focus. |
| Side pane        | Ordinary workspace pane (`workspace-tabs/open-beside.ts`), one remembered per workspace                                                         |

The seam is `packages/app/src/panels/panel-manifest.ts:3`:

```ts
export type PaneHost = "main" | "explorer";
export interface PanelManifest<K> {
  kind: K;
  supportedHosts: readonly PaneHost[];
  resourceKey(target): string;
}
```

Existing declarations fall into three patterns:

- `["explorer"]` — `files`, `changes_tree`. Explorer's **singleton navigation views**, toggled
  from the tab rail context menu.
- `["main"]` — `browser`, `setup`. Interactive things you work _in_.
- `["main", "explorer"]` — `file`, `working_diff`, `agent`, `terminal`, `commit_diff`,
  `pull_request`, `plugin`, `draft`, `new_tab`, `provider_subagent`.

**Recommended shape**, mirroring how `files` and `file` already split:

- `artifacts` (the list) → `supportedHosts: ["explorer"]`
- `artifact` (one rendered document) → `supportedHosts: ["main", "explorer"]`

An artifact viewer patterns on `file`, not `browser` — it is a static document, not an
interactive session.

### Rendering — already solved, reuse it

`packages/app/src/file-pane/html-preview.web.tsx` and `html-preview.tsx` already render
agent-authored HTML on both web and native, with a deliberate threat model:

- Web: `sandbox="allow-scripts"` only (`:17`) — opaque origin, no access to Paseo's DOM,
  cookies, or storage; `referrerPolicy="no-referrer"`.
- Native: `react-native-webview` with a per-document navigation latch,
  `originWhitelist: ["*"]` (deliberate — a narrow list routes custom schemes to
  `Linking.openURL`, bypassing the guard), `domStorageEnabled={false}`, `cacheEnabled={false}`,
  `incognito`.
- Shared CSP in `html-preview-csp.ts`: `default-src 'none'`, `connect-src 'none'`,
  `form-action 'none'`.

The source comment states plainly: "Agent-written HTML is not trusted markup." Known residual
hole — a page can navigate _itself_; `navigate-to` was dropped from CSP3 — disclosed in
SECURITY.md rather than papered over.

**Do not build a renderer.** Reuse `FileHtmlPreview`. The Electron browser pane is the wrong
comparison: it is an interactive browser, and its webviews are created with `allowpopups="true"`
(`packages/app/src/desktop/browser/resident-webviews.ts:308`).

### Transport — use the fork's WebSocket binary channel

Upstream serves file bytes over `/api/files/download`, a self-authenticating route
(`packages/server/src/server/auth.ts:122`). **That path does not exist over a relay
connection** — a relay carries only `/health` and `/ws`, which is the root cause behind
#543, #3753, #3521, #1954.

This fork already fixed that. `50ec16f30 feat(files): move workspace file transfer onto the
WebSocket binary channel (#9)` adds:

- `fs.entry.download.request` / `.response`
- `fs.entry.upload.request` / `.response`
- `fs.transfer.ack` / `fs.transfer.cancel` (bidirectional, keyed by originating requestId)
- `packages/server/src/server/session/files/workspace-files-session.ts`
- `packages/protocol/src/binary-frames/transfer-flow-control.ts`

Artifacts must serve through this, not the HTTP route — otherwise they are broken on mobile
over relay, which is Paseo's headline use case.

### Storage — PASEO_HOME, keyed by `projectId`

Not in the working tree. A `.paseo/artifacts/` folder would need a per-repo gitignore, dies
with a Paseo-owned worktree on archive, dies to `git clean -xfd`, and is meaningless for
non-git `directory` workspaces.

Precedent for PASEO_HOME storage keyed off a workspace:
`packages/server/src/server/agent/agent-storage.ts:429` `projectDirNameFromCwd()` →
`~/.paseo/agents/<cwd-slug>/<id>.json`. Also
`packages/server/src/server/agent/providers/provider-image-output.ts:91`, which materializes
agent-produced binary output content-addressed by hash.

**Key by `projectId`, not `projectKey` and not `cwd`.** `docs/data-model.md` settles it:

> Workspace `projectId` is **stable membership**: reconciliation may update git-derived kind
> and branch metadata, but never rehomes a workspace or changes a project's root, ID, or
> default name. (`:5`)
>
> `kind` and `projectKey` are **mutable metadata, not identity**. (`:13`)

Concrete failure if you key by `projectKey`: a local directory with no remote gets
`host:<serverId>:/path` (`project-key.ts:24-32`); the user adds a GitHub remote; reconciliation
rewrites the key in place (`workspace-reconciliation-service.ts:359-360`); every artifact
published before that becomes unreachable. Verified still true at 0.7.0.

`projectId` also groups worktrees, which is the reason `cwd` was rejected — an artifact produced
by an agent in a worktree should stay visible from the main checkout.

### Tool seam — right place, non-uniform delivery

`packages/server/src/server/agent/tools/paseo-tools.ts` is the cross-provider registry
(`create_agent`, `create_workspace`, `capture_terminal`, `create_schedule`, …). It is the right
home for `publish_artifact`.

Delivery is **not uniform**. Three tiers at 0.7.0:

| Tier                | Providers                  | Path                                                                |
| ------------------- | -------------------------- | ------------------------------------------------------------------- |
| Native, always      | OMP                        | `omp/agent.ts:466` `supportsNativePaseoTools: true`                 |
| Native, conditional | OpenCode                   | `opencode-agent.ts:1410-1412` — only when `deps.bridge` is injected |
| MCP                 | Claude, Codex, Copilot, Pi | injected `/mcp/agents` server, `runtime-mcp-config.ts`              |

Gate: `agent-manager.ts:4842-4848`. The catalog backs both native and MCP paths, so registering
once is correct — but any design doc claiming "every provider receives it through
`AgentLaunchContext.paseoTools`" is wrong.

The catalog also has **no `projectId` resolver** today. `publish_artifact` would need to look up
caller agent → workspace → project via `workspaceRegistry`/`projectRegistry`.

### Claude provenance is blocked

`packages/server/src/server/agent/providers/claude/tool-call-mapper.ts` has **no `Artifact`
case**, and drops the payload: `raw.output` feeds `deriveClaudeToolDetail` (`:119-120`) but the
returned item carries only `detail` and optional `metadata` (`:127-140`). The published URL never
survives the mapper.

Fix that before building the Claude half. An unmapped tool does _not_ render blank — it falls
through `resolveClaudeToolKind` to `"unknown"` and `resolveDetailName`'s `default:` returns the
raw name, so it renders as a generic card with the correct name but no clickable URL.

### Protocol and naming

- `packages/protocol/src/messages.ts:3612` declares `ArtifactMessageSchema`
  (`markdown|diff|image|code` — **no `html`**), wired into the union at `:6339`, with zero
  producers and zero consumers. `packages/app/src/components/message.tsx` has a
  `type: "artifact"` `NoticeRow` branch with `onArtifactClick` and no call sites.
  **Decide: extend it or delete it.** Shipping a second "artifact" noun alongside it is the worst
  outcome.
- "Artifact" is not in `docs/glossary.md`, and already means CI build artifacts elsewhere in the
  repo (e.g. issue #2870). Add a glossary entry.
- New RPCs: dotted namespaces per `docs/rpc-namespacing.md`
  (`domain.provider.operation.request`/`.response`). Capability-gate on
  `server_info.features.*` per `docs/protocol-compatibility.md`; wire schemas stay pure.

## Open decisions

1. **Retention.** Nothing deletes artifacts. Keyed by `projectId`, they survive workspace
   archive, worktree removal, and project removal. No TTL, no quota, no per-artifact delete.
   Needs an answer before v1.
2. **Size cap.** No limit today. An agent embedding base64 images writes a 200MB artifact.
   Claude's own artifacts cap at 16MB. Enforce at write time in `publish_artifact`.
3. **Collision and cross-agent read scope.** Can agent B overwrite agent A's artifact? Needs
   opaque IDs, not names. Can an agent _list_ or _read_ another agent's artifacts? That is a
   cross-agent information channel — a prompt-injected agent reading a sibling's output.
4. **Tool-catalog cost.** `publish_artifact` in the always-on catalog puts it in every agent's
   tool list in every session. `paseoToolsEnabled` is a global boolean
   (`agent-manager.ts`), not per-tool.
5. **Singleton presence.** As an explorer-only singleton, `artifacts` becomes a permanent entry
   in the tab rail context menu whether or not any artifacts exist. Cheaper than a visible empty
   tab, not free. (An earlier claim that the panel "does not seed itself" came from the deleted
   `docs/side-panel.md` — re-check against `docs/explorer-sidebar.md` before relying on it.)
6. **Injection exposure.** The self-navigation hole is acceptable for a file the user opened from
   their own repo. Artifacts are agent-authored by construction, listed in a surface that invites
   clicking, and agents routinely ingest untrusted input (issues, PRs, web pages, MCP output).
   Same mitigation, worse odds. Worth a SECURITY.md line if this ships.

## Dead ends — do not re-derive

- `.paseo/artifacts/` in the working tree. Rejected: gitignore friction, worktree archive
  destroys it, `git clean -xfd` destroys it, meaningless for non-git workspaces.
- Keying by `projectKey`. Rejected: reconciliation rewrites it in place; `docs/data-model.md`
  says it is not identity.
- Keying by `cwd`. Rejected: fragments artifacts per worktree.
- Building a new HTML renderer, or reusing the Electron browser pane. Rejected:
  `FileHtmlPreview` already exists, cross-platform, with a considered threat model.
- Serving bytes over `/api/files/download`. Rejected: no HTTP path over relay.
- Assuming `paseoTools` reaches every provider. False — see the three tiers above.

## Related upstream context

- Issue [#3561](https://github.com/getpaseo/paseo/issues/3561) — "Claude artifacts are not
  working". Root-caused this session: Claude Code withholds the `Artifact` tool when
  `CLAUDE_CODE_ENTRYPOINT` is `sdk-cli`/`sdk-ts`/`sdk-py`; `CLAUDE_CODE_ARTIFACT=1` overrides it.
  Verified end-to-end with `paseo run --env CLAUDE_CODE_ARTIFACT=1`. Comment posted
  ([#issuecomment-5385295075](https://github.com/getpaseo/paseo/issues/3561#issuecomment-5385295075)).
  Still open, no maintainer reply.
- Issue [#3428](https://github.com/getpaseo/paseo/issues/3428) — render MCP Apps (`ui://`
  interactive artifacts) inline. Open, unlabeled. Adjacent design space.
- Discussion [#2915](https://github.com/getpaseo/paseo/discussions/2915) — sharing what an agent
  did without giving machine access. The natural second half of this feature (sharing),
  deliberately out of scope for v1.
- Discussions #3444, #3352, #3520, #3575 — reading/copying agent output. Same underlying need.
- Repo policy: feature requests filed as **Issues** get auto-closed by `paseo-bot`. Post to
  **Discussions**.

## Suggested next steps

1. Decide retention + size cap + ID scheme (open decisions 1–3). These shape the storage format,
   so settle them before writing code.
2. Land `publish_artifact` in `paseo-tools.ts` with a `projectId` resolver. This is the feature;
   the UI is the view.
3. Register `artifacts` and `artifact` panel kinds in `panel-manifest.ts` with the
   `supportedHosts` above, reusing `FileHtmlPreview`.
4. Wire reads through the fork's `fs.entry.download` WS path.
5. Resolve the dead `ArtifactMessageSchema`, add the glossary entry.
6. Claude provenance last — it needs the `tool-call-mapper.ts` fix first.

Optionally: write the Discussion post before building, cross-linking #2915/#3428/#3444 so
maintainers get one thread instead of six.

## Re-verifying

Everything above was read at `0.7.0`. To re-check after a rebase:

```bash
grep -rn 'supportsNativePaseoTools' packages/server/src | grep -v '\.test\.'
grep -n 'projectKey' packages/server/src/server/workspace-reconciliation-service.ts
grep -rn 'ArtifactMessageSchema' packages/*/src
grep -n 'supportedHosts' packages/app/src/panels/panel-manifest.ts
grep -n 'SANDBOX\|sandbox=' packages/app/src/file-pane/html-preview.web.tsx
grep -n -i 'artifact' packages/server/src/server/agent/providers/claude/tool-call-mapper.ts
```

Two reviewer agents ran against 0.5.x and their transcripts are still in the workspace:
`artifacts-review-codex`, `artifacts-review-opencode`. Their `paseoTools` finding (OMP-only) is
now stale — OpenCode gained conditional support. Everything else they found held at 0.7.0.
