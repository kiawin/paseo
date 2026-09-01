# Artifacts

An artifact is an HTML document an agent published so a person can read it. The agent calls
`publish_artifact`; the daemon stores the bytes; the Artifacts view in the Explorer lists them and
opens them in the same sandboxed preview the file pane uses.

The problem it solves is the last mile of a long agent run. An agent that has produced a report, a
dashboard, or a diagram has nowhere to put it except the transcript, and a wall of text in a
transcript is not a deliverable. Writing it into the repo is worse: it is not source, it dirties
the working tree, and reaching it from a phone means the file is on the wrong machine.

See [security.md](../SECURITY.md#artifacts) for the threat model, and
[glossary.md](glossary.md) for the noun — "artifact" never means a CI build output here.

## Why the key is `projectId`

A workspace is one `cwd`. A project spans every workspace on it, worktrees included. An agent that
publishes from a worktree is working on the same thing as the agent in the main checkout, and the
person reading the result does not care which one produced it. Keying by `cwd` would fragment one
project's deliverables across its worktrees; keying by `workspaceId` would lose them when the
workspace is archived.

`projectKey` is the wrong key for a different reason: reconciliation rewrites it in place
(see [data-model.md](data-model.md#project-identity)), and an artifact must not move when a git
remote changes.

## Why the bytes travel over the WebSocket

`GET /api/files/download` cannot reach the daemon through a relay — a relay answers only its own
`/ws`, `/health`, `/ready` and `/metrics`. Remote access is the reason this feature exists, so an
HTTP route would ship it broken on the platform it is for.

Artifacts therefore reuse the workspace file-transfer channel unchanged: the `FileBegin` /
`FileChunk` / `FileEnd` opcodes, and `fs.transfer.ack` / `fs.transfer.cancel` for flow control.
Those messages are keyed by `requestId` and carry no path, which is what makes them shareable. The
session routes ack and cancel to both the workspace and artifact subsystems, and each ignores a
`requestId` it does not own.

## What the store has to get right

`ArtifactStore` sits on `FileBackedRegistry`, which gives it a serialized mutation queue and an
atomic index write. A publish is not one write, and the parts that are easy to get wrong:

- **One lock over quota and index.** Selecting eviction victims and committing the index share the
  inherited queue. Split them and two concurrent publishes each compute a total that excludes the
  other, and each picks the other as the victim.
- **Ordering.** HTML renamed into place, then index commit, then victim unlink. A crash in either
  gap leaves an HTML file no record names, which the startup sweep reclaims — an orphan otherwise
  counts against the project quota forever. The sweep also drops records whose file is gone,
  because a listed artifact that cannot be opened is worse than an absent one.
- **Monotonic stamps.** `updatedAt` is the eviction order, so stamps advance past the newest record
  on disk rather than trusting millisecond wall-clock resolution. Two publishes in one tick would
  otherwise be unordered, and "evict the oldest" would mean nothing.
- **Pinning does not touch `updatedAt`.** It is not a content change and must not reorder the list.
  An overwrite does refresh it, which is what moves a record the user keeps updating out of the
  eviction firing line.
- **A pinned artifact is never evicted, even over quota.** Blind eviction destroys something a
  person deliberately kept. The quota loses that argument.

Not covered: an artifact open in a pane can still be evicted by a concurrent publish. The pane
already holds the bytes and keeps rendering; reopening it reports the artifact as gone. Pin it if
that matters.

## Read is project-wide, write is not

Any session in a project may list and read its artifacts — that is the sharing boundary the feature
exists to provide. Overwriting and deleting require the record's own `origin.agentId`, because
knowing an `artifactId` must not confer destructive write over a sibling agent's deliverable. A
session-initiated delete (the user, through the UI) is allowed on the strength of
`workspace.write`; an agent's overwrite is not.

## Replay

`publish_artifact` optionally carries the provider tool-call id that produced it. The store treats
`(origin.agentId, origin.callId)` as an idempotency key, so publishing the same call twice resolves
to the record it already produced. This matters because provider adapters reach their
completed-tool-result handler from history replay as well as live streaming — capturing there
unguarded would republish every artifact in a session's history on every reload.

## The companion link is generic

The field is `externalUrl`, not `claudeUrl`. The name is permanent — the protocol never narrows or
removes — and a vendor noun in a wire schema outlives the integration that motivated it. More
practically, the premise of the feature is that non-Claude agents have no way to hand back a
rendered deliverable; with a vendor-named field, an agent that deployed the same HTML somewhere has
nowhere to put the link. `origin.provider` already records the vendor.

Vendor knowledge belongs at capture. Only Claude Code has an `Artifact` tool, so filling
`externalUrl` in automatically is Claude adapter code, not shared plumbing.

## Adding a surface

The Explorer has two presentations that do not share chrome
(see [explorer-sidebar.md](explorer-sidebar.md)). Desktop draws a pane whose tabs are ordinary
closable tabs, and its singleton views are toggled from the tab rail's context menu — which lists
exactly the launch items whose panel does not support the `main` host. Compact draws an overlay
with a fixed header tab bar. A new Explorer view has to be wired into both.

Artifacts sits outside the compact tab bar's `isGit` guard on purpose: they are project-scoped, and
a non-git `directory` workspace belongs to a project that can hold them.

One trap worth knowing before adding the next view: persisted panel state is validated as a single
strict object, and a failed parse deletes the entry — every width, every expansion, not just the
offending field. Widening the persisted `ExplorerTab` enum therefore used to be a downgrade hazard.
The persisted tab now degrades an unrecognised value to the default instead of failing the object,
so the next view is free.
