# Chat trace presentation plan

Make a completed agent turn scannable without collapsing it. The reference is Claude Code's VS Code transcript, analyzed from screenshots on 2026-08-25/26. Every anchor below was verified against `origin/main` at 0.5.2.

The reference is not a theme. Paseo's themes are palettes — `THEME_OPTIONS` in `packages/app/src/styles/theme.ts:756` is `light dark auto zinc midnight claude ghostty`, and the plugin bridge (`packages/app/src/plugins/theme.ts`) exposes six colors. Nothing in that layer can change layout. This plan changes renderers.

## Reference vocabulary

Observed, not inferred. One unbroken vertical rail spans the whole turn; every node hangs off it with a status dot.

| Node                   | Rendering                                                                   |
| ---------------------- | --------------------------------------------------------------------------- |
| User message           | Bordered card — the only boxed element in the view                          |
| Dot                    | green = ok · red = denied/failed · grey = non-tool                          |
| Thinking               | `Thought for 6s` — dot plus muted text, duration included, no body          |
| Interim assistant text | dot plus plain prose, no box                                                |
| Cheap tool             | `**Read** settings.json (lines 53-66)` — header row only, no card           |
| Payload tool           | `**Bash** <description>` plus an IN/OUT card                                |
| File edit              | `**Edit** settings.json`, `Added 4 lines`, then an inline side-by-side diff |
| Final answer           | dot plus full markdown, no box, blue clickable file links                   |

Two details that cost an afternoon to read correctly:

- **Diffs stay in the transcript.** They do not open an editor tab. Side-by-side, two independent line-number gutters, diagonal hatching where content is absent on a side, syntax highlighting preserved, height-clamped with a `Click to expand` pill.
- **The card is conditional.** A tool whose payload is its own header (`Read`) renders no card at all.

Clamping is adaptive, not fixed: a one-line output gets a one-line card; a multi-line heredoc input clamps to ~3 lines and **slices the next line mid-glyph** as the overflow signal. No chevron, no fade.

## Paseo today

| Element                      | State                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Header = name + description  | Have it — `displayName` + `summary`, `packages/app/src/tool-calls/presentation.ts:70`                       |
| Height clamp                 | Have it — `maxHeight ?? 300`, `packages/app/src/components/tool-call-details.tsx:751`                       |
| "does this tool have detail" | **Computed and ignored** — `hasDetails` / `canOpenDetails`, `presentation.ts:66`                            |
| Split diff renderer          | **Exists, unreachable from chat** — `buildSplitDiffRows`, `packages/app/src/utils/diff-layout.ts:251`       |
| Chat diff path               | Hardcoded unified — `useDiffLines` → `parseUnifiedDiff`, `tool-call-details.tsx:135`                        |
| Rail + status dot            | Missing. Paseo resolves a per-tool icon (`presentation.ts:72`), so the left edge is ragged by glyph width   |
| Tighter markdown scale       | Precedent exists — `createCompactMarkdownStyles`, `packages/app/src/styles/markdown-styles.ts:360`          |
| Content width                | `MAX_CONTENT_WIDTH = 820`, `packages/app/src/constants/layout.ts:15`. Measure is fine; not a problem to fix |

`buildSplitDiffRows` is consumed only by `packages/app/src/git/diff-document/model.ts:196` — the git panes. The chat path never reaches it. That asymmetry is the cheapest win in this plan.

## Strategy: fix the renderers, add no mode

Lean first. Slices 1, 2 and 4 lose no information and need no setting — they are strictly better renderings of the same data. Only slice 3 changes visual identity, and it is the one that needs a decision rather than code.

Side-by-side needs width, so slice 1 gates on `useIsCompactFormFactor()` from `@/constants/layout`, not on a user preference. Compact keeps unified. This is the existing convention for layout capability and avoids a settings key nobody asked for.

`ToolCallDetailLevel = "overview" | "detailed"` (`packages/app/src/hooks/use-settings/storage.ts:35`, default `"detailed"`) stays a two-value enum unless slice 3 lands as opt-in. If a third value is ever needed, `packages/app/src/hooks/use-settings/migrations.ts` is the seam and `stored.toolCallDetailLevel ?? (stored.compactToolCalls ? "overview" : "detailed")` in `storage.ts` is the worked precedent for widening.

## Slices

| #   | Slice                                           | Effort | Risk   |
| --- | ----------------------------------------------- | ------ | ------ |
| 1   | Side-by-side diff in chat Edit rows             | S      | low    |
| 2   | Suppress the detail card for payload-free tools | S      | low    |
| 3   | Rail plus status dots                           | M      | medium |
| 4   | Stop markdown block margins from stacking       | S      | low    |

### Slice 1 — side-by-side diff in chat

`useDiffLines` (`tool-call-details.tsx:135`) returns a flat `DiffLine[]` and the `detail.type === "edit"` branch (`tool-call-details.tsx:664`) renders it unified. Route through `buildSplitDiffRows` when the form factor is wide, keeping the unified path for compact.

The absent-side hatching is the part with no existing equivalent — `SplitDiffRow` already models `left: … | null` / `right: … | null` (`diff-layout.ts:84`), so the null side is where the hatch goes.

Acceptance: an Edit tool call on desktop renders two gutters with the changed hunk aligned across them; the same call on a phone renders unchanged.

### Slice 2 — suppress the card for payload-free tools

`hasDetails` is already computed at `presentation.ts:66` and already gates `canOpenDetails`. The renderer draws the card regardless. Gate the card on it, and fold the payload into the header row for the tools that have one (`Read` → path plus line range).

Acceptance: a `Read` call occupies one row.

### Slice 3 — rail plus status dots

Replace `input.resolveIcon(...)` (`presentation.ts:72`) at the call site with a uniform dot colored by status, and draw one continuous line behind the node column. `ToolCallStatus` (`presentation.ts:11`) already carries `executing | running | completed | failed | canceled` — the red dot for denied/failed is the half that carries the most information, and Paseo has the state for it today.

This changes what every user sees. It is a maintainer decision, not a code problem. If it must be opt-in, that is when `ToolCallDetailLevel` grows a third value and `migrations.ts` earns its keep.

Acceptance: the left edge of a turn is a straight line; a denied tool call is identifiable without reading its output.

### Slice 4 — margin stacking

Independent of everything above; a spacing bug, not taste. Adjacent block margins sum instead of collapsing, so a table followed by a heading produces a band nothing asked for:

| Site                                             | Value             |
| ------------------------------------------------ | ----------------- |
| `markdown-styles.ts:220` `table.marginVertical`  | `spacing[3]` = 12 |
| `markdown-styles.ts:80` `heading2.marginTop`     | `spacing[6]` = 24 |
| `markdown-styles.ts:85` `heading2.paddingBottom` | `spacing[2]` = 8  |
| `markdown-styles.ts:81` `heading2.marginBottom`  | `spacing[3]` = 12 |

`heading1`/`heading2` also carry `borderBottomWidth: 1` (lines 70, 83), which is the rule under headings in the app today. Whether that rule stays is a separate taste call — leave it.

Prior art: [#2329](https://github.com/getpaseo/paseo/issues/2329) documented this with the same anchors and was closed under the bugs-only intake policy.

Acceptance: a table immediately followed by an `h2` produces one gap, not the sum of four.

## Non-goals

- **No-wrap plus pane-level horizontal scroll.** The reference clips monospace and scrolls the whole transcript sideways. Worst cost/benefit in the set, fights `packages/app/src/agent-stream/web-virtualization.ts`, and breaks compact form factors.
- **Routing diffs to the side panel.** Dropped. An early reading of the reference had diffs opening an editor tab; the second screenshot disproved it.
- **Narrowing the measure.** `MAX_CONTENT_WIDTH = 820` is already the binding constraint. The first screenshot suggesting otherwise was 2× DPR.
- **A new theme.** Palettes cannot express any of this.
- **Changing defaults toward "collapse the process."** Five Discussions ask for that ([#3352](https://github.com/getpaseo/paseo/discussions/3352), [#3520](https://github.com/getpaseo/paseo/discussions/3520), [#3575](https://github.com/getpaseo/paseo/discussions/3575), [#3444](https://github.com/getpaseo/paseo/discussions/3444), [#2690](https://github.com/getpaseo/paseo/discussions/2690)) and the reference layout does the opposite — it shows everything, bounded. Both are coherent; they are not compatible defaults. This plan takes the scannability and leaves the default alone.

## Open questions

1. Does Paseo box the user message today? The reference boxes it and nothing else. Not yet observed in a Paseo screenshot.
2. What does Paseo's `Edit` row look like in chat right now? Slices 1 and 2 are scoped from code, not from seeing the current rendering.
3. Slice 3: unconditional, or a third `ToolCallDetailLevel` value?
