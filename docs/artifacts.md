# Artifacts

An artifact is a titled deliverable an agent published so a person can read it. The agent calls
`publish_artifact`; the Artifacts view in the Explorer lists what a project has.

A row is backed one of two ways, and `contentSha256` is what says which:

| `contentSha256` | Backing                                  | Opening the row                                     |
| --------------- | ---------------------------------------- | --------------------------------------------------- |
| set             | HTML the daemon stored                   | Renders in the sandboxed preview the file pane uses |
| `null`          | Nothing; `externalUrl` is where it lives | Opens the link externally                           |

One record type with an optional body, not two lists. Every consumer — the startup sweep, the
viewer, the download RPC — reads the same field, so there is no second thing to keep in sync and
no state to infer from a missing file.

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
`requestId` it does not own — which is exactly why one id must never name two transfers. Both
subsystems refuse an id already in flight, in themselves or in the other, and so does the client:
an ack carries nothing else to tell two transfers apart, so a shared id paces and cancels both.
A download also records the socket that asked for it, because the logical session outlives any one
socket and a transfer parked at its flow-control window would otherwise wait forever on an ack that
can no longer come.

## What the store has to get right

`ArtifactStore` sits on `FileBackedRegistry`, which gives it a serialized mutation queue and an
atomic index write. A publish is not one write, and the parts that are easy to get wrong:

- **One lock over quota and index.** Selecting eviction victims and committing the index share the
  inherited queue. Split them and two concurrent publishes each compute a total that excludes the
  other, and each picks the other as the victim.
- **Content is immutable, so ordering can be safe.** The path carries the digest —
  `<projectId>/<artifactId>.<contentSha256>.html` — so a publish only ever adds a file. New HTML
  in place, then the index commit, then the superseded and evicted files unlink. Until the index
  moves it names a digest whose file is still there, so a crash at any point leaves a consistent
  pair; what it can leave is an HTML file no record names, which the startup sweep reclaims — an
  orphan otherwise counts against the project quota forever. Replacing content in place instead
  would let a crash strand the index claiming one digest over another's bytes, which no sweep can
  detect. The id stays in the filename because addressing by digest alone would let two records
  share a file, and deleting either would destroy the other's content.
- **A download reads the record it advertised.** `readContent` takes the record, not an id, so the
  digest in the transfer's metadata describes the bytes behind it. Re-resolving the id would let an
  overwrite land in between and stream the new document under the old digest.
- **The sweep's rule is the digest, not the file.** A record that claims a `contentSha256` must
  have its file, and one that claims none must not. Sweeping on "no file means delete" instead
  would remove every link-only row on the first restart.
- **A link-only row costs a slot, not bytes.** It counts against the 100-record cap and nothing
  against the 200 MB one.
- **Monotonic stamps.** `updatedAt` is the eviction order, so stamps advance past the newest record
  on disk rather than trusting millisecond wall-clock resolution. Two publishes in one tick would
  otherwise be unordered, and "evict the oldest" would mean nothing.
- **Pinning does not touch `updatedAt`.** It is not a content change and must not reorder the list.
  An overwrite does refresh it, which is what moves a record the user keeps updating out of the
  eviction firing line.
- **A pinned artifact is never evicted, even over quota.** Blind eviction destroys something a
  person deliberately kept. The quota loses that argument.
- **The project record is the cascade's tombstone.** Removing a project runs its artifact cleanup
  _before_ the record commits, and refuses the removal if that fails. Cascading only from the
  after-commit listener would leave a crash halfway through with the project already gone and
  nothing left to retry from — the sweep keeps those artifacts, correctly, because their files are
  intact. The after-commit listener still runs, idempotently, to collect anything a publish landed
  during the first pass.

Not covered: an artifact open in a pane can still be evicted by a concurrent publish. The pane
already holds the bytes and keeps rendering; reopening it reports the artifact as gone. Pin it if
that matters.

## Read is project-wide, write is not

Any session in a project may list and read its artifacts — that is the sharing boundary the feature
exists to provide. Overwriting and deleting require the record's own `origin.agentId`, because
knowing an `artifactId` must not confer destructive write over a sibling agent's deliverable. A
session-initiated delete (the user, through the UI) is allowed on the strength of
`workspace.write`; an agent's overwrite is not.

## Invalidation is opt-in

A publish comes from the agent runtime, which owns no session, so the daemon fans `artifact.changed`
out itself — but only to sockets that have sent `artifact.list.request`. `features.artifacts`
describes what the daemon supports, not what a client understands, and an app built before this
feature rejects the unknown discriminator outright and logs a protocol failure on every publish.
Having listed artifacts is the proof a client knows the message, and it is also the only client
holding a list worth invalidating.

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

## Why a Claude artifact is a link and not a copy

Claude Code's own `Artifact` tool publishes to claude.ai, and the local file it was given is
tempting to copy. Don't. A Claude artifact can declare runtime capabilities (`window.claude.*`)
and reference uploaded assets as `_blob/{id}`, and both only exist on the claude.ai origin. Copied
into Paseo's sandbox, such a page looks right and silently does not work — the worst failure this
feature can have, because the list exists to be trusted.

So the rule has no heuristic in it: what Claude publishes to claude.ai is recorded link-only, and
the live page stays canonical. An agent that wants a document Paseo actually holds — including
Claude — writes the HTML and calls `publish_artifact` with it. That path is unaffected and is the
normal one.

Capture happens in `AgentManager`, not in the Claude adapter, and keys on the `artifact` tool-call
detail rather than on a tool name. Every path that records a timeline item runs it, hydration
included — a session resumed after an upgrade holds completed artifact calls that no live capture
ever saw, and a capture that failed once is retried on the next load. Any provider that grows a
publishing tool is captured by mapping onto that detail; nothing in the manager has to change.
The manager reports the publication, and `artifact-capture.ts` resolves the agent's workspace to
a project and files it — so the manager needs neither the store nor the registry.

Two properties that path depends on. The store keys publication on `(agentId, callId)`, which is
what makes capture safe from a code path that also runs on history replay: reloading a session
resolves to the record it already produced instead of adding another. And the recorder never
rejects — the tool call has already succeeded and the agent is not waiting, so a failure to file
the record is logged and dropped rather than allowed to disturb the turn.

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
