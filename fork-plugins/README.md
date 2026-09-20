# Fork plugins

Paseo plugins owned by this fork. Upstream has no directory of this name, so nothing here ever
conflicts during a rebase onto `upstream/main`.

Do not put fork features in `plugin-examples/` — that tree belongs to upstream and is theirs to
restructure. Do not put them in `packages/` either unless they genuinely cannot be a plugin: core
files are the ones that make every sync expensive, and a fork-local addition to `packages/protocol`
also breaks mixing a fork daemon with an upstream app.

| Plugin              | What it does                                           | Hosts        |
| ------------------- | ------------------------------------------------------ | ------------ |
| [spotify](spotify/) | Play/pause and now-playing for the Spotify desktop app | macOS daemon |

## Installing

Each plugin installs against one daemon. From a checkout:

```bash
paseo plugin install "$PWD/fork-plugins/<name>"
```

From anywhere, without a checkout — Paseo clones and manages it:

```bash
paseo plugin add kiawin/paseo:fork-plugins/<name>
paseo plugin update <name>
```

Both require `pluginsEnabled: true` in that daemon's `config.json`. Plugins are trusted, unsandboxed
code: server contributions run with the daemon user's access, client contributions run inside the
Paseo app.

## When a plugin needs a core change

Some capabilities cannot live in a plugin — the macOS Automation entitlement the Spotify plugin
needs belongs to the app bundle's own Info.plist and signature. Keep those changes as small as
possible, comment them at the site with the plugin that depends on them, and expect to re-resolve
them on rebase.
