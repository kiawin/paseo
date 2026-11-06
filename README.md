# GenUI link preferences: QA evidence

[Watch or download the 29-second recording](link-preferences.mp4).

## What was exercised

The fixture imports the real Paseo `useOpenLink`, `Link`, `ExternalLink`, settings hooks/storage, and GenUI components. Before uses GenUI commit `cd50b2a6b86583eb48915a17d919fd319f0c30ec`; after uses `4153b4039c9ba8d45ce9be0452e0efedd4fca49b` together with Paseo `38d469b331f447a1ab98c4ef94fa879718626c8a`.

The recording checks the original external-opening bug, corrected OpenUrl/Markdown/Sources behavior, independent Agent links and Pull request links preferences, external fallback when no workspace opener exists, and both preferences surviving reload. All ten recorded checks passed with no browser page errors.

## Boundaries

This is a Chromium source integration fixture, not the full Paseo app or an Electron session. The desktop bridge and the containing workspace's browser-opening callback are instrumented to show the observed destination. Real browser AsyncStorage, React Query settings updates, public hook/component, and GenUI controls run directly from source. The app's Vite test aliases supply UI/platform helpers (theme, icons, safe areas, etc.). It does not create a real Electron webview or open an OS browser.

No main daemon, installed plugin, or live user's preferences were changed. iOS, Android, macOS/Windows/Linux Electron shells remain unverified. GenUI needs the companion API/SDK release before ordinary installation can work.

## Automated validation

- Paseo app link/public runtime tests: 82 passed.
- Production plugin compiler boundaries and server runtime tests: 149 passed.
- GenUI link/core/Markdown tests: 25 passed.
- Full Paseo typecheck and lint passed after rebuilding dependencies on the current main base.
- GenUI typecheck passed using the locally packed companion SDK.
- Both GenUI client and server entries compiled through Paseo's production compiler, without installation/activation.

Raw test JSON and command logs are in [checks](checks). [results.json](results.json) holds the ten video assertions. [provenance.json](provenance.json) records source commits and the video digest.

## Reproduce the fixture

Use these source revisions in separate Paseo and GenUI checkouts. Build Paseo dependencies with `npm run build:server`; pack its local plugin SDK and install that tarball into the GenUI checkout without changing the lockfile, as described in the GenUI README. Copy [fixture](fixture) into Paseo's `.dev/link-qa` and populate `.dev/link-qa/source/before` and `source/after` with `git archive` of the GenUI before/after commits. The temporary fixture deliberately stays outside the source PR.

From the Paseo checkout, run:

```sh
node node_modules/vite/bin/vite.js --config .dev/link-qa/vite.config.mts
# In another terminal:
node .dev/link-qa/record.mjs
```

The recorder needs installed Playwright Chromium. It writes screenshots, `results.json`, and a WebM into `.dev/link-qa/evidence`. Convert the video to MP4 with ffmpeg using H.264, yuv420p, and faststart. `compile-genui.mjs` currently expects the GenUI checkout at `/tmp/paseo-plugin-genui-link-preference`; adjust that one fixture path when reproducing elsewhere.
