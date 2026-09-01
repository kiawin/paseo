# Implementation plan: Artifacts

Companion to `ARTIFACTS-HANDOFF.md`. That doc records what was investigated; this one records
what to build. Both are scratch — delete before opening a PR.

Re-verified against the worktree at `de635ffd7` (0.7.0). Every file:line below was read, not
recalled.

## The shape, in one paragraph

An **artifact** is an HTML document an agent publishes, owned by Paseo, scoped to a
**project**, listed in a fourth Explorer sidebar view, and rendered in the existing sandboxed
preview. When the document also lives at a public URL, the same record carries that URL as a
companion link. One record type, one noun, one storage location.

### Why one record and not two

`ARTIFACTS-HANDOFF.md` proposed two sources: artifacts Paseo owns, and Claude URLs Paseo merely
witnessed. Collapse them. Claude Code's `Artifact` tool takes a **local `file_path`** — the HTML
already exists in the workspace when the tool runs, so Paseo can copy it at capture time and set
`externalUrl` on the same record. A Claude artifact is a Paseo artifact that also has a URL.

That removes an entire second code path (list rendering, empty states, a "link-only" viewer
mode) and matches the request: _store the HTML and a companion link_.

The link still opens **externally** — never inside `FileHtmlPreview`. The preview is for bytes
Paseo holds; a published page is a live site.

### The companion link is generic, the capture is vendor-specific

The field is `externalUrl`, not `claudeUrl`.

A vendor-named field costs exactly the same as a generic one — it is a name, not an extension
point, so this is not speculative structure. Three things argue for the generic name:

- **The name is permanent.** Protocol rule: never narrow, never remove. A vendor noun in a wire
  schema outlives the integration that motivated it.
- **It unblocks the stated motivation.** The whole premise is that non-Claude agents have no way
  to hand back a rendered deliverable. With `claudeUrl`, a Codex agent that deployed the same
  HTML to a host or pushed it as a gist has nowhere to put the link. With `externalUrl`,
  `publish_artifact` takes an optional `externalUrl` and every provider gets the companion link;
  Claude is only special in that Paseo fills it in automatically.
- **`origin.provider` already records the vendor.** A second vendor tag on the URL is redundant
  with a field the record carries anyway.

The app needs no vendor branch either: derive the affordance label from
`new URL(url).hostname` — "Open on claude.ai" — which works for any host.

**Vendor knowledge is confined to capture.** Only Claude Code has an `Artifact` tool, so the
mapper case and the `agent.ts:2600` hook are Claude adapter code. Providers already diverge
heavily there; that is the right home for it.

## Blocking prerequisite: this branch does not build

`npm run build:server` fails at `de635ffd7` with `packages/` byte-identical to HEAD. Verified,
not inferred:

```
operation-permissions.ts(415,29): error TS2551: Property 'fs.entry.download.request'
  does not exist on type '{...}'. Did you mean 'fs.entry.delete.request'?
operation-permissions.ts(412,12): error TS1360: Type '{...}' does not satisfy the expected
  type 'Record<"status" | ... | "fs.transfer.ack" | "fs.transfer.cancel" | ...>'
```

`50ec16f30` (fork PR #9) added `fs.entry.download.request`, `fs.entry.upload.request`,
`fs.transfer.ack` and `fs.transfer.cancel` to `SessionInboundMessageSchema`
(`messages.ts:3036-3234`, entries at `:3185-3188`) but never classified them in
`server/authorization/operation-permissions.ts`. Both maps are
`as const satisfies Record<InboundOperation | OutboundOperation, DaemonPermission | null>`
(`:201`, `:412`) — total by construction, so an unclassified RPC is a compile error, not a
silent default.

The runtime consequence, if a build were produced: `INBOUND_PERMISSION[op]` returns `undefined`
for a missing key; `allows()` is `permission === null || this.permissions.has(permission)`
(`authorization/index.ts:51-53`), and `undefined` is neither — so it denies. The gate at
`session.ts:1861` is unconditional for every inbound message on every session, owner included.
Fail-closed, but the fork's headline file-transfer feature would be denied for everyone.

This tension is unresolved and worth checking before building on it: the running daemon reports
`0.7.0-beta.1.kiawin.gfff20d5` and PR #9 shipped with QA, so either the released artifact
predates the protocol change or the release build path differs from `npm run build:server`.

**Fix `operation-permissions.ts` first, in its own commit.** Every RPC this plan adds needs an
entry in both maps too — that is a mandatory integration point the original plan omitted
entirely.

## Decisions

The handoff doc left six open. Answers, with reasons.

| #   | Decision              | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Retention             | Per-project cap: 100 artifacts or 200 MB, whichever binds first; evict oldest by **`updatedAt`** on publish, with pinning. Explicit `artifact.delete` RPC. Cascade-delete on project removal built on the mutation hook at `workspace-registry.ts:483-495` — the hook exists, an artifact listener does not, and project removal commits before awaiting listeners without the workspace listener's error isolation (`:620-629`), so the cascade must be idempotent and retryable. No TTL. See Retention below. |
| 2   | Size cap              | 10 MB per artifact, enforced in `publish_artifact` before any write. Under Claude's own 16 MB. It is **larger** than the 8 MiB flow-control window on purpose — that window bounds outstanding unacknowledged bytes, not object size, so a 10 MB artifact simply spans several acked chunks. Test above the window.                                                                                                                                                                                             |
| 3   | IDs, collision, scope | Opaque `art_<id>`, server-minted. **Read and write are separate rights.** Any agent in the project may list and read — that is the sharing boundary being asked for. Overwrite and delete require origin ownership (`origin.agentId`) or an explicit replace token, because knowing an `artifactId` must not confer destructive write over a sibling agent's deliverable. Reject stale updates.                                                                                                                 |
| 4   | Tool-catalog cost     | One tool, always on, no per-tool gating. `paseoToolsEnabled` stays a global boolean. Adding per-tool config for a single tool is scaffolding.                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | Singleton presence    | `artifacts` is a permanent fourth Explorer view alongside `changes` / `files` / `pr`, with an empty state. Matches `files`, which is also always present on a repo with no interesting files.                                                                                                                                                                                                                                                                                                                   |
| 6   | Injection exposure    | Reuse `FileHtmlPreview` unchanged. Add a SECURITY.md paragraph — same sandbox, worse odds, because artifacts are agent-authored by construction and the surface invites clicking.                                                                                                                                                                                                                                                                                                                               |

## Data model

```
$PASEO_HOME/artifacts/
  index.json                       one FileBackedRegistry file, all projects
  <projectId>/<artifactId>.html    document bytes
```

```ts
PersistedArtifactRecord {
  artifactId: string;          // "art_..." opaque, server-minted
  projectId: string;           // identity, never projectKey, never cwd
  title: string;
  mimeType: "text/html";       // one value today; a field so adding markdown later is additive
  size: number;
  createdAt: string;
  updatedAt: string;
  externalUrl: string | null;  // companion link; Claude's Artifact tool fills it automatically
  origin: {
    agentId: string | null;
    workspaceId: string | null;
    provider: AgentProvider | null;
  };
}
```

`projectId` is settled by `docs/data-model.md:5` — stable membership, never rehomed.
`projectKey` is rewritten in place by reconciliation
(`workspace-reconciliation-service.ts:359-360`), and `cwd` fragments artifacts per worktree.

**Storage is under `$PASEO_HOME`, never in the working tree.** Precedent:
`agent-storage.ts:429` and `provider-image-output.ts:87-99`.

### One refactor this needs

`FileBackedRegistry<TRecord>` is a **private class** at `workspace-registry.ts:169` — the
atomic-write, schema-validated, id-keyed store both registries extend. Extract it to
`packages/server/src/server/file-backed-registry.ts` and import it from all three call sites.
Do not copy it, and do not hand-roll a third JSON store.

## Protocol

Naming per `docs/rpc-namespacing.md`: `domain.namespace.operation.direction`, operation is a
**verb**, response data under `payload`, `requestId` in both.

| RPC                                             | Payload                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `artifact.list.request` / `.response`           | `{ projectId }` → `{ artifacts: PersistedArtifactRecord[] }`. Metadata only — never the HTML.                 |
| `artifact.entry.download.request` / `.response` | `{ artifactId }` → `{ success, mimeType, size, error }`, then bytes over the binary channel.                  |
| `artifact.delete.request` / `.response`         | `{ artifactId }` → `{ success, error }`                                                                       |
| `artifact.changed` (push, no response)          | `{ projectId }` — list invalidation. Call the one-way shape out in a comment next to the schema, per the doc. |

Adding an RPC is not one edit. The full checklist, each verified as a real site:

1. Schema in `packages/protocol/src/messages.ts`, wire-pure — no `.transform()`, `.catch()`,
   `.preprocess()`.
2. Requests into `SessionInboundMessageSchema` (`:3036-3234`); responses and the `artifact.changed`
   push into the outbound union.
3. Exported inferred types alongside the schemas.
4. **`server/authorization/operation-permissions.ts`** — an entry in `INBOUND_PERMISSION` **and**
   `OUTBOUND_PERMISSION`. Both maps are total, so omitting one fails the build. Proposed:
   `artifact.list` → `workspace.read`, `artifact.entry.download` → `workspace.read`,
   `artifact.delete` → `workspace.write`.
5. Regenerate the outbound validator via `packages/protocol/codegen/ws-outbound.compile.ts`.
6. Session dispatch wiring in `packages/server/src/server/session.ts`.
7. The site that actually advertises the flag. Adding an optional field to the `features` object
   at `messages.ts:3400` does **not** make `server_info.features.artifacts` true — find where
   `workspaceFileTransfer` is set and set this beside it.

Feature gate: `server_info.features.artifacts`, tagged
`// COMPAT(artifacts): added in v0.7.x, remove gate after <date+18mo>`.

Flow control reuses `fs.transfer.ack` / `fs.transfer.cancel` **unchanged**: both are keyed by
`requestId` only and carry no `cwd` (`messages.ts:2718-2728`). The binary opcodes
`FileBegin`/`FileChunk`/`FileEnd` are likewise transport-agnostic
(`binary-frames/file-transfer.ts:4-8`).

### The client-side refactor

`daemon-client.ts:4651` `downloadEntry()` is ~90 lines of sink registration, ack pacing, abort
wiring and cleanup. Extract **only the transport lifecycle** into a private
`streamBinaryDownload({ requestId, message, responseType, sink, signal })`, and let each
operation keep its own response validation and result mapping.

An earlier draft claimed exactly two lines were workspace-specific. That is wrong: the response
acceptance check and the returned `kind` / `fileName` / `mimeType` / `size` at `:4710-4728` are
file-entry semantics and do not generalize to an artifact.

Cloning the lifecycle instead would duplicate the backpressure invariants in
`packages/protocol/src/binary-frames/transfer-flow-control.ts` and its tests.
(`docs/terminal-performance.md` covers terminal coalescing and retained streams — it does not
define file-transfer invariants, and citing it for them was an error.)

**HTTP is not an option.** `/api/files/download` (`server/auth.ts:122`) does not exist over a
relay — a relay carries only `/health` and `/ws`. That is the root cause of #543, #3753, #3521,
#1954, and serving artifacts over it would ship the feature broken on the platform it is for.

## The tool

`publish_artifact`, registered in `paseo-tools.ts` next to `capture_terminal` (`:2432`).

```
publish_artifact(title: string, html: string, artifactId?: string, externalUrl?: string)
  -> { artifactId, title, size }
```

Reject over 10 MB before writing. `artifactId` present ⇒ overwrite that record; absent ⇒ mint.
`externalUrl` is how a non-Claude agent attaches a companion link — a deploy URL, a gist — to
the artifact it just published. Validate the scheme at write time (`http:` / `https:` only);
that mirrors what `openExternalUrl` enforces at the other end.

Resolution chain, which the catalog does **not** have today: `callerAgentId` (already on
`PaseoToolRuntimeContext`, `tools/types.ts:36`) → `agentManager.getAgent()` → `workspaceId` →
`workspaceRegistry.get()` → `projectId`. `paseo-tools.ts:1657-1661` is the existing precedent
for the first half, including the error text when an agent has no workspace. Both registries
are already injected (`:113-114`), but only `"get" | "list" | "upsert"` — no change needed.

**Delivery is not uniform.** Registering once in the catalog is correct, because the catalog
backs both paths, but the three tiers are real and any claim that `AgentLaunchContext.paseoTools`
reaches every provider is false:

| Tier                | Providers                  | Path                                                           |
| ------------------- | -------------------------- | -------------------------------------------------------------- |
| Native, always      | OMP                        | `omp/agent.ts:466`                                             |
| Native, conditional | OpenCode                   | `opencode-agent.ts:1412` — only when `bridge` is injected      |
| MCP                 | Claude, Codex, Copilot, Pi | injected `/mcp/agents` server; gate at `agent-manager.ts:4844` |

## App surface

### Panels

`panel-manifest.ts` gains two kinds, mirroring how `files` and `file` already split:

```ts
artifacts: { kind: "artifacts", supportedHosts: ["explorer"],          resourceKey: () => "artifacts" },
artifact:  { kind: "artifact",  supportedHosts: ["main", "explorer"],  resourceKey: (t) => t.artifactId },
```

The viewer patterns on `file`, not `browser`. It is a static document, not an interactive
session — and the Electron browser pane creates webviews with `allowpopups="true"`
(`desktop/browser/resident-webviews.ts:308`), which is the opposite of what this needs.

Targets in `workspace-tabs/model.ts:36-49`: `{ kind: "artifacts" }` and
`{ kind: "artifact"; artifactId: string }`.

### Explorer view

Registering a panel takes more than `panel-manifest.ts`. The manifest holds only hosts and
`resourceKey`; `PanelRegistration extends PanelManifest` and adds the component and its
presentation (`panels/panel-registry.ts:38-46`). Nine sites, all found:

**Panel plumbing**

1. `panels/panel-manifest.ts` — the two manifest entries above.
2. `panels/artifacts-panel.tsx` and `panels/artifact-panel.tsx` — new files, each calling
   `definePanel(kind, { component, presentation })` with `label`/`subtitle`/`tooltip`/`icon`
   (`panel-registry.ts:31-36,75`). Model on `panels/files-panel.tsx` and `panels/file-panel.tsx`.
3. `panels/register-panels.ts:1-36` — import both registrations and `registerPanel(...)` them.
   A panel not registered here is invisible to the launcher and the tab rail.
4. `workspace-tabs/model.ts:36-49` — the two targets.

**Desktop pane**

5. `workspace-tabs/launcher/index.tsx:78-86` — `BUILT_IN_SELECTIONS` gains
   `artifacts: { kind: "target", target: { kind: "artifacts" } }`, plus its catalog entry with
   `panelKind` and `shortcutActionId`. This is how an explorer view is opened on desktop — the
   new-tab launcher, **not** a tab-rail context menu.
6. `screens/workspace/workspace-desktop-tabs-row.tsx:530-565,1008-1016` — `resolveTabLabel` and
   the labels object, so the tab renders a name instead of falling through to `labels.agent`.

**Compact overlay**

7. `components/compact-explorer-sidebar.tsx:329-383` — `availableTabs` and a fourth
   `ExplorerTabButton`, **outside** the `isGit` guard — plus the matching content branch and
   `RetainedPanel` entry at `:408-430` and the `useMountedTabSet` cap. A tab button with no
   retained surface renders a selectable blank view.
8. `stores/panel-store/state.ts:119` — `ExplorerTabSchema = z.enum(["changes","files","pr"])`
   gains `"artifacts"`. **This is not backward-safe and an earlier draft claimed it was.**
   `PanelPersistedStateSchema` is a `z.strictObject` (`:131`), so when an older build reads a
   persisted `explorerTab: "artifacts"` the enum parse fails and **the whole entry is dropped** —
   the user's entire panel state, not just the tab. Coercion never runs. The comment at
   `:122-127` documents exactly this failure for a previous field. Either parse the persisted tab
   tolerantly (unknown → default, entry preserved) or keep the stored enum old-compatible and
   carry the new view in a separate key.

**Shared**

9. `workspace-tabs/explorer-sidebar.ts:11,13-17` — `ExplorerSidebarView` and `VIEW_TARGETS`.
   Also `workspace-tabs/identity.ts:58,143,222` for singleton identity, same branch as `files`,
   and the close-button test ID in `screens/workspace/workspace-tab-menu.ts:154` — that block
   builds test IDs, not menu entries.
10. `screens/workspace/workspace-screen.tsx` — the mobile/tab-switcher fallback-label maps and
    their target-kind switches. A new panel target has to be handled here as well as in the
    desktop tab row.
11. `i18n/resources/en.ts` and **every other locale resource** — `panels.artifacts.label`,
    `subtitle`, `tooltip`, the compact tab label, and the empty-state copy. The resource-shape
    tests fail on a key present in one locale and missing in another.

Note the seam: compact explorer state is keyed by **checkout**
(`ExplorerCheckoutContext`), while artifacts are keyed by **project**. Resolve
checkout → workspace → `projectId` at the store boundary; do not thread `projectId` through the
explorer's checkout plumbing.

### Wireframes

The Explorer has **two presentations** and they do not share chrome
(`explorer-sidebar.ts:29-35`): desktop gets a pane whose tabs are ordinary closable tabs;
compact gets an overlay with a fixed header tab bar.

**Desktop pane.** Tabs are whatever you opened, each closable, labelled by
`resolveTabLabel` (`workspace-desktop-tabs-row.tsx:539-565`). There is no fixed three-up
control, and a PR tab is present only if someone opened one.

```
┌─ Explorer ───────────────────┐┌─ Main pane ─────────────────────┐
│  Files ✕ │ Artifacts ✕ │ +   ││  Q3 revenue dashboard ✕ │ +     │
├──────────────────────────────┤├─────────────────────────────────┤
│                              ││  ↗ claude.ai                 ⋯  │
│  ▸ Q3 revenue dashboard      │├─────────────────────────────────┤
│    2.1 MB · 3m ago · ↗       ││ ┌─────────────────────────────┐ │
│                              ││ │                             │ │
│  ▸ Migration risk report     ││ │  FileHtmlPreview, unchanged │ │
│    184 KB · 1h ago           ││ │  sandbox="allow-scripts"    │ │
│                              ││ │                             │ │
│  ▸ API surface diagram       ││ └─────────────────────────────┘ │
│    42 KB · yesterday         ││                                 │
└──────────────────────────────┘└─────────────────────────────────┘
   artifacts ["explorer"]           artifact ["main", "explorer"]
```

**Compact overlay.** Here the fixed tab bar is real
(`compact-explorer-sidebar.tsx:346-383`). `Changes` and `PR` are gated on `isGit` /
`showPrTab` (`:330-332`); `Files` is not. **`Artifacts` is unconditional too** — artifacts are
project-scoped and a non-git `directory` workspace can hold them.

```
git workspace                    non-git workspace
┌────────────────────────────┐   ┌────────────────────────────┐
│ Changes Files PR#42 Artif… ✕│   │ Files  Artifacts         ✕ │
├────────────────────────────┤   ├────────────────────────────┤
│ ▸ Q3 revenue dashboard     │   │ ▸ Q3 revenue dashboard     │
│   2.1 MB · 3m ago          │   │   2.1 MB · 3m ago          │
│   ↗ claude.ai              │   │   ↗ claude.ai              │
│ ▸ Migration risk report    │   │ ▸ Migration risk report    │
│   184 KB · 1h ago          │   │   184 KB · 1h ago          │
└────────────────────────────┘   └────────────────────────────┘
        tap ─────▸ full-screen viewer
```

Four tabs crowd the compact header. Check the label against `panels.artifacts.label` at the
narrowest supported width before settling on "Artifacts".

Empty state — the view is a permanent singleton (decision 5), so a fresh project shows:

```
┌──────────────────────────────┐
│  Files ✕ │ Artifacts ✕ │ +   │
├──────────────────────────────┤
│                              │
│   No artifacts in this       │
│   project                    │
│                              │
│   Agents publish them with   │
│   publish_artifact.          │
│                              │
└──────────────────────────────┘
```

Viewer chrome is a title, the companion link when set, and nothing else — a document, not a
browser. No address bar, no back/forward, no popups.

### Viewer

`FileHtmlPreview` from `file-pane/html-preview` — the same component `file-pane/pane.tsx:172`
already uses, with `sandbox="allow-scripts"` on web (`html-preview.web.tsx:17`), a navigation
latch on native, and the shared CSP in `html-preview-csp.ts`. Do not build a renderer, do not
change the sandbox, do not add popup tokens.

When `externalUrl` is set, the viewer shows an affordance that calls `openExternalUrl`
(`utils/open-external-url.ts`) — which already enforces an `http:`/`https:` allowlist on both
web and native, for the same reason it lists: forge-supplied URLs reach that sink. Do not
re-derive the scheme check.

**Label the affordance with the hostname**, derived via `new URL(url).hostname`, not a bare
"Open" button. No Claude-specific branch, and the destination is visible before the tap — which
is the mitigation for the open-redirect surface noted under Security.

Never load that URL into the preview.

## Claude provenance

Two problems, in order.

**1. The URL never leaves the provider.** `claude/tool-call-mapper.ts` has no `Artifact` case.
`resolveClaudeToolKind` (`:69`) falls through to `"unknown"`, `resolveDetailName`'s `default:`
returns the raw name, and the item renders as a generic card with the right name and no
clickable link. `raw.output` reaches `deriveClaudeToolDetail` (`:120`) but the returned item
carries only `detail` and optional `metadata` (`:127-140`).

Fix: add an `Artifact` case producing a new `ToolCallDetail` variant
`{ type: "artifact"; url: string; title?: string }` in `agent-types.ts:200-291`. Adding a
variant is additive; an older client hits the display layer's unknown-detail path.

**2. Capture has no live-only seam, and an earlier draft named the wrong one.**

The real completed-tool-result path is `claude/agent.ts:5162`, inside `handleToolResult`
(`:5134`), where `toolName`, `callId`, `entry.input` and `buildToolOutput(...)` are all in hand.
That is where an `Artifact` result and its URL actually arrive.

`agent.ts:2600` is **not** an Artifact path at all — it is `respondToPermission`'s plan branch
synthesizing a `plan_approval` tool call. An earlier draft of this plan had the two reversed and
told the implementer to capture at `:2600` while avoiding `:5162`. Both halves were wrong.

The replay hazard is real but attaches to the correct line: `handleToolResult` is reached from
`convertHistoryEntry` → `mapBlocksToTimeline` → `mapBlockToTimeline` (`:5028`, `:5106`), so it
runs on history load as well as live streaming. Capturing there unguarded would republish every
artifact in a session's history on every reload.

So capture needs one of:

- a live/replay discriminator threaded into `handleToolResult`, or
- idempotent publication — key the record on `(agentId, callId)` so a replayed result resolves
  to the existing artifact instead of a new one.

Prefer the second: it survives any future path that also replays, and it needs no new flag.

**3. The copy can fail.** Collapsing witnessed links into owned records assumes the file at
`input.file_path` still exists, is readable from the agent cwd, and still holds the bytes Claude
published when the result arrives. None is guaranteed. Give the record an explicit capture state
(`owned`, `link-only`, `failed`) so a Claude deliverable degrades to a working companion link
rather than vanishing. Store a content digest so a later overwrite can detect drift.

Sequencing: this is last. It needs the store, the tool, and the detail variant to exist first.

Unrelated but adjacent — #3561: Claude Code withholds the `Artifact` tool entirely when
`CLAUDE_CODE_ENTRYPOINT` is `sdk-cli`/`sdk-ts`/`sdk-py`. `CLAUDE_CODE_ARTIFACT=1` overrides it,
verified end-to-end. Without that env var this half of the feature has nothing to capture.

## Dead code to remove first

`messages.ts:3660` `ArtifactMessageSchema` — `markdown|diff|image|code`, no `html`, inline
`content` string with an `isBase64` flag. Zero producers, zero consumers; union member at
`:6422`, type alias at `:6611`. The `NoticeRow` branch in `components/message.tsx:2037-2172`
(`onArtifactClick`, `artifactId`, `artifactType`) has no call site passing `type: "artifact"`.

**Do not extend it, and do not delete the parser.** Its transport shape — the whole document
inline in a JSON message — is exactly what the binary channel exists to avoid, so extending it
would be building the thing this plan rejects.

But removing it is a protocol narrowing, which `docs/protocol-compatibility.md` forbids outright:
never narrow, never remove. "Nothing in this checkout produces it" is not proof that no peer at
any shipped version sends it, and this plan cannot establish that. Deprecate instead — leave the
schema parsing, mark it `// COMPAT(artifactMessage): superseded by the artifact RPCs, remove
after <date>`, and remove only the dead `NoticeRow` UI branch in `components/message.tsx`, which
is local and provably unreachable.

## Order

0. **Fix `operation-permissions.ts`** so the server package builds. Own commit, ahead of
   everything. Nothing below can be verified until this lands.
1. Deprecate `ArtifactMessageSchema` (keep the parser, tag it, drop the dead `NoticeRow` branch).
   Add the `docs/glossary.md` entry — "artifact" already means CI build artifact elsewhere
   (#2870), so the disambiguation has to land before the noun spreads.
2. Extract `FileBackedRegistry` to its own module.
3. `ArtifactStore` on top of it: paths, cap, the lock, ordering and recovery, eviction rules,
   project-removal cascade.
4. Protocol: the seven-step checklist above, for each of the four RPCs.
5. Server session handler; extract `streamBinaryDownload` in `daemon-client.ts` and add
   `downloadArtifact` with its own response validation.
6. `publish_artifact` in `paseo-tools.ts` with the `projectId` resolver and the ownership rule.
7. App: panel kinds, targets, explorer view, list panel, viewer panel, i18n keys, persisted-state
   migration.
8. Claude provenance: detail variant, mapper case, idempotent capture at `agent.ts:5162`.
9. SECURITY.md paragraph.

Steps 2–6 are the feature. 7 is the view. 8 is additive on top of a working feature — if it
slips, artifacts still work for every provider.

## Retention, atomicity, and authorization

`FileBackedRegistry` serializes and atomically replaces one JSON index
(`workspace-registry.ts:318-349`). A publish is not one write: it is an HTML file write, an index
mutation, a quota computation, zero or more evictions, and a notification. Extraction does not
make that atomic.

Specify, before writing code:

- **One store-owned lock.** Quota selection and index mutation must share it, or two concurrent
  publishes each decide the other is the eviction victim.
- **Ordering and recovery.** Temp write → durable rename → index commit → victim deletion. Define
  what a crash between any two steps leaves behind, and sweep orphaned files on startup — an
  orphan otherwise counts against the 200 MB forever.
- **Eviction edge cases.** Can an incoming artifact evict itself? Does an overwrite count its old
  bytes or its new ones against quota? Overwriting refreshes `updatedAt` but an eviction ordered
  by `createdAt` would still take it — order by `updatedAt`.
- **Pinning.** Blind eviction destroys a deliverable a user deliberately kept, and can delete the
  artifact currently open in a pane. Support pinning, and never evict the open one.
- **Cascade isolation.** Project removal commits before awaiting listeners and lacks the workspace
  listener's error isolation (`:620-629`), so a failed artifact deletion reports removal failure
  after the project is already gone. Make the cascade idempotent and retryable; test partial
  deletion.
- **Authorization.** Read is project-wide; overwrite and delete require origin ownership. Record
  auditable provenance on every mutation.

## Security

Add to SECURITY.md, in the section that already discloses the preview's self-navigation hole:

- Artifacts are agent-authored **by construction**, unlike a repo file the user chose to open.
  Agents routinely ingest untrusted input — issues, PRs, web pages, MCP output. Same sandbox,
  same residual hole, materially worse odds.
- Project-scoped read is a **cross-agent information channel**, and combined with
  `externalUrl` it is a durable exfiltration channel: one compromised agent can read a sibling's
  artifact and republish the contents to an address it controls. Read is deliberate; that pairing
  is what needs the separate write/delete right and audit trail from the Retention section.
- **Active content is not just an exfiltration risk.** The CSP allows `'unsafe-inline'` and
  `'unsafe-eval'` (`html-preview-csp.ts:16-17`), so a hostile artifact can monopolize CPU or
  exhaust memory in the viewer; on native the navigation latch can lose a race when the JS thread
  stalls. Self-navigation can carry document contents, user input, device properties and IP off
  the device. Consider a user-mediated first open or execution limits, not disclosure alone.
- `externalUrl` is **agent-supplied and unvalidated beyond its scheme**. A prompt-injected agent
  can publish an artifact whose companion link points anywhere, on a surface that invites
  clicking. The mitigation is that the affordance shows the hostname rather than a bare "Open"
  button. A host allowlist was rejected deliberately: it would only work for Claude and would
  remove the reason the field is generic. Scheme validation plus a visible hostname still does
  **not** cover loopback and private-network targets (a GET against `127.0.0.1` or `10.x` is a
  CSRF primitive), lookalike/IDN domains, or a public URL that is compromised later. Consider an
  interstitial showing the normalized destination, and blocking loopback/private ranges by
  default.
- `externalUrl` opens through `openExternalUrl` and is never loaded into the preview.

## Verification

- `npm run build:server` must pass before anything else is meaningful (see the blocking
  prerequisite). A fresh checkout needs `npm ci` first, and this repo pins node 22.20.0 via
  `.tool-versions` — a bare shell here resolves node 24, and `mise exec -- npm` resolves a global
  npm 12 that refuses node 22, so run through node's own bundled npm.
- `npm run typecheck` and `npm run lint` after every step. Run `npm run build:client` /
  `npm run build:server` first if cross-package declaration errors appear — do not patch inferred
  callback params to silence stale `dist`.
- `npm run format` before committing.
- Targeted tests only, per the repo rule — never the full suite:
  - `npx vitest run packages/server/src/server/artifact-store.test.ts --bail=1`
  - `npx vitest run packages/protocol/src/messages.artifacts.test.ts --bail=1`
  - `npx vitest run packages/client/src/daemon-client.test.ts --bail=1` (the extraction is a
    refactor of a covered path — this is the regression check that matters)
  - `npx vitest run packages/app/src/stores/panel-store/state.test.ts --bail=1`
- QA evidence per `docs/qa.md`: the platform matrix, plus one screenshot of a rendered artifact
  **over a relay connection on mobile**. That is the case the HTTP route cannot serve and the
  reason for the transport choice.

## Out of scope for v1

- Sharing artifacts outside Paseo (discussion #2915) — the natural second half.
- Non-HTML artifact types. `mimeType` is a field so this stays additive.
- MCP Apps / `ui://` interactive artifacts (#3428) — adjacent design space, different threat model.
- Per-tool catalog gating.
