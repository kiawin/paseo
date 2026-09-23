# Notes

A note is a project-scoped Markdown document that people and agents can read or write. The Notes
view in the Explorer lists notes from the project's daemon hosts. Each daemon keeps the bodies it
owns; the app federates matching hosts at read time.

See [data-model.md](data-model.md#directory-layout) for the on-disk layout and
[glossary.md](glossary.md) for the product noun.

## Why the key is `projectId`

Use the daemon's `projectId` as the note's ownership key. A project spans its worktrees, while a
workspace can be archived. `projectKey` is grouping metadata and reconciliation may rewrite it, so
it cannot anchor stored content.

One repo can appear on two daemons. When Git remotes identify the same project, the app
groups the host placements and reads each daemon's notes. Each note keeps its host-local
`projectId`; saves, reads, and deletes still go to the daemon that owns the row. This is read-time
federation, not replication.

Without a Git remote, the grouping key includes the daemon's `serverId`. The same local path on two
daemons therefore stays separate.

## Saves and deletes

Use last-writer-wins for saves. A stale save still becomes the next revision. The save response
reports `replacedRevision`, and the editor tells the writer which revision it replaced.

Delete uses compare-and-set. The request carries the revision the user saw, and the daemon refuses
the delete when that revision is stale, returning the current revision. Saves accept concurrent
edits so agents and people can continue writing; deletes require a current view because they are
destructive.

## The size limit

Keep each note at or below 64 KiB of UTF-8 body bytes. The cap is checked on the decoded body. The
`/mcp/agents` route accepts up to 512 KiB of encoded JSON so JSON escaping
and the request envelope have room before `write_note` applies the decoded-body cap. Other routes
keep their existing parser limit.

## Platform scope

Phone and tablet can list and read notes. They do not edit or delete them. Web and desktop provide
the editor and delete action. Native authoring remains deferred.

## Offline is partial

The app caches note metadata, not bodies, per host. When a host is offline, you can see which notes
exist and what they are called if that metadata was previously cached. The body still needs a
connection, so opening a note is not an offline read.

## Invalidation is opt-in

The daemon sends `note.changed` only after the client has advertised Notes capability, subscribed
to note events, and requested note metadata or content. Both `note.list.request` and
`note.read.request` register the client because a list or a directly opened note can be the first
Notes surface it uses.

Older clients must not receive `note.changed`: their outbound validator rejects an unknown message
discriminator. The capability and subscription checks protect the wire, while list/read
registration limits invalidation to clients that have a Notes surface to refresh.
