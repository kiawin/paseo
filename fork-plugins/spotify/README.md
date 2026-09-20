# Spotify

Play/pause and now-playing for the Spotify desktop app, driven over AppleScript from the daemon host.

macOS only, and the constraint lands on the **daemon**, not the client: install this on the daemon
running beside Spotify. Any connected client then controls it, phone included.

## What it contributes

| Surface                | Where                                              |
| ---------------------- | -------------------------------------------------- |
| `Spotify` sidebar item | Full player: artwork, progress, previous/play/next |
| Header button          | One click toggles playback; label is the track     |
| Command Center items   | ⌘K → play/pause, next, previous                    |

The header button hides itself whenever Spotify is unreachable, so it never offers a dead control.
The sidebar surface stays visible and explains which of the five failure states you are in.

## How it reads state

`server/spotify.ts` holds one AppleScript constant that returns every field in a single Apple event.
Three details are not obvious from the code:

- **Address Spotify by bundle id.** `tell application "Spotify"` on a Mac without Spotify opens a
  "Where is Spotify?" file chooser and blocks the daemon until someone dismisses it.
- **`running` is the only safe probe.** Every other property access launches Spotify. A name-based
  poll would start a music player every few seconds.
- **`duration of current track` is milliseconds; `player position` is seconds.** The script converts
  position to milliseconds before returning, and rounds it there — emitting a real would pick up the
  system decimal separator on non-English Macs.

Fields are joined with a `|~|` sentinel rather than newlines or tabs, because track titles carry
quotes, commas, pipes, and occasionally newlines. `parseSnapshot` is pure and covered by
`server/spotify.test.ts`.

## macOS Automation consent

The first command triggers a TCC prompt attributed to whichever process is responsible for the
daemon.

**Daemon started from a terminal** — Terminal or iTerm is responsible. It already ships the required
usage description, so the prompt appears, and the grant is stable across rebuilds.

**Daemon started by Paseo.app** — Paseo.app is responsible, and it needs two things that this branch
adds to `packages/desktop`:

- `NSAppleEventsUsageDescription` in `electron-builder.yml`. Without it macOS suppresses the dialog,
  the event fails with `-1743`, and no entry ever appears under **Privacy & Security → Automation**
  for you to grant by hand.
- `com.apple.security.automation.apple-events` in both entitlements plists, which hardened runtime
  requires. Unsigned local builds skip hardened runtime, so it is inert there and matters the moment
  the app is signed.

An unsigned build has no stable code identity, so the grant may not survive a rebuild. Re-allowing is
one click. `tccutil reset AppleEvents sh.paseo.desktop` forces a fresh prompt while testing.

## Install

```bash
npm install
npm run typecheck
paseo plugin install "$PWD"
paseo plugin ls
```

Requires `pluginsEnabled: true` in the daemon's `config.json`.
