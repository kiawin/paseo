# QA evidence — Artifacts

Scratch. The contents belong in the pull request body; drop this file before opening it.

Screenshots are produced by `e2e/browser/artifacts-qa-evidence.spec.ts` under
`packages/app/test-results/`, which is gitignored. Regenerate with:

```
npm --workspace @getpaseo/app run test:e2e -- e2e/browser/artifacts-qa-evidence.spec.ts
```

## 1. Does it work well

| #   | Screenshot                                     | Shows                                                                                                                                                                                                         |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | `01-desktop-empty-state.png`                   | Empty state against the **real daemon** — reaching it rather than the unsupported state proves `features.artifacts` was advertised and a real `artifact.list` round trip succeeded through the permission map |
| 02  | `02-desktop-list.png`                          | All three backings in one list: stored (`32 B · 1d ago`), stored with a companion link (`180.0 KB · 1d ago · ↗ claude.ai`), and link-only (`1d ago · ↗ claude.ai`, no size)                                   |
| 03  | `03-desktop-viewer.png`                        | A stored artifact rendering in the sandboxed preview, opened as a main-pane tab                                                                                                                               |
| 04  | `04-desktop-viewer-with-companion-link.png`    | The `↗ Open on claude.ai` bar above the preview — labelled by host, not a bare "Open"                                                                                                                         |
| 05  | `05-compact-tab-bar.png`                       | `Changes │ Files │ Artifacts` in the compact overlay's fixed header at 390 px                                                                                                                                 |
| 06  | `06-compact-list.png`                          | Same three rows in the overlay                                                                                                                                                                                |
| 07  | `07-compact-viewer.png`                        | Full-screen viewer on compact                                                                                                                                                                                 |
| 08  | `08-main-pane-launcher-excludes-artifacts.png` | Artifacts absent from the main pane's `+` menu — `supportedHosts: ["explorer"]`, same as Files and Changes                                                                                                    |

Layout: no shift observed between empty, loading and populated states — the list is a plain
scroll of fixed-height rows and the viewer's chrome is one optional bar. Row meta drops the size
segment for a link-only artifact rather than rendering `0 B`.

## 2. Does it regress anything else

Surfaces around the change, re-run green: the workspace file-transfer session (`downloadEntry`
now shares its transport lifecycle with `downloadArtifact`), the workspace and label registries
(`FileBackedRegistry` was extracted out from under them), session dispatch (its `??` chain became
an ordered list), and wire compatibility.

```
npx vitest run \
  packages/server/src/server/artifact-store.test.ts \
  packages/server/src/server/artifact-capture.test.ts \
  packages/server/src/server/agent/agent-manager.artifact-capture.test.ts \
  packages/server/src/server/agent/tools/publish-artifact.test.ts \
  packages/server/src/server/agent/providers/claude/tool-call-detail-parser.artifact.test.ts \
  packages/protocol/src/messages.artifacts.test.ts \
  packages/client/src/daemon-client.test.ts \
  packages/server/src/server/workspace-registry.test.ts \
  packages/server/src/server/workspace-labels/index.test.ts \
  packages/server/src/server/session/files \
  packages/server/src/server/session.test.ts \
  packages/server/src/server/wire-compat.test.ts --bail=1

 Test Files  12 passed (12)
      Tests  441 passed (441)
```

```
npx vitest run --project unit src/i18n src/utils src/workspace-tabs src/stores/panel-store \
  src/stores/explorer-tab-memory.test.ts --bail=1

 Test Files  92 passed (92)
      Tests  701 passed (701)
```

```
npm run test:e2e -- e2e/browser/artifacts-pane.spec.ts e2e/browser/artifacts-qa-evidence.spec.ts

  8 passed (48.9s)
```

```
npm run typecheck && npm run lint && npm run format:check
  Found 0 warnings and 0 errors.
  All matched files use the correct format.
```

Not a hot path: artifacts are fetched once per project on panel open and re-fetched on an
`artifact.changed` push. No terminal, message-list or git-polling code is touched.

## 3. Every platform it affects

| Platform        | Tested | Notes                                                                                                                                                                                           |
| --------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS             | ✗      | Not run. Compact overlay code is shared with web and exercised at 390 px, but `FileHtmlPreview` on native is the WebView implementation with the navigation latch, which this did not exercise. |
| Android         | ✗      | Same as iOS.                                                                                                                                                                                    |
| Web             | ✓      | Chromium via Playwright, desktop (1400×900) and compact (390×844).                                                                                                                              |
| Desktop macOS   | ✗      | Not run.                                                                                                                                                                                        |
| Desktop Windows | ✗      | Not run.                                                                                                                                                                                        |
| Desktop Linux   | ✓      | Daemon under test is the Linux build; the e2e harness starts a real one per worker.                                                                                                             |

No platform-gated code was added — no `isWeb`, `isNative`, or `getIsElectron()` branches. The
native path is the existing `FileHtmlPreview.native`, reused unchanged.

## 4. Automated coverage that means something

- **`fix(server): classify the file-transfer RPCs`** is a regression fix with a failing-before
  proof: `npm run build:server` failed at `de635ffd7` with `TS1360`/`TS2551` on
  `operation-permissions.ts`, on a tree byte-identical to HEAD under `packages/`.
- **Store invariants** (33 tests) cover the parts that are easy to get wrong rather than the
  happy path: eviction ordering under both caps, pinning, self-eviction, the crash-recovery
  sweep in both directions, and overwrite ownership.
- **Capture idempotency** is tested by publishing the same `(agentId, callId)` twice and
  asserting one row — the property that makes capture safe from a path that also runs on
  history replay.
- **The e2e stubs only the two artifact read RPCs** and proxies everything else to a real
  daemon, so the app, the transport, the ack pacing and the sandbox are all real.

## Gaps, stated

- **The four-tab compact header is uncovered.** The fixture repo has no pull request, so the
  overlay shows three tabs. `Changes │ Files │ PR #42 │ Artifacts` at 390 px is the crowding case
  and it has not been seen.
- **`ToolCallDetailsContent`'s artifact branch has no render test.** A browser test needed two
  changes to the shared vitest config to bundle `react-native-gesture-handler` and
  `hoist-non-react-statics`; that was the wrong trade for one presentational component, so it was
  reverted. Its inputs are unit-tested (`externalLinkHost`, the Claude parser branch, icon and
  meaningfulness mapping).
- **The Claude `Artifact` result shape is inferred, not observed.** The tool is withheld unless
  `CLAUDE_CODE_ARTIFACT=1` (#3561) and the only local sample is an `action: "list"` call, so the
  parser scrapes the first `http(s)` URL out of the result text. End-to-end capture from a live
  Claude run has not been exercised.
- **No relay run.** `docs/qa.md` asks for a rendered artifact over a relay on mobile, which is
  the case the HTTP route cannot serve and the reason for the transport choice. Not done.
