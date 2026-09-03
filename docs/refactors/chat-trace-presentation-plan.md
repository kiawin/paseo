# Chat trace presentation plan

Make a completed agent turn scannable without collapsing it. The reference is Claude Code's VS Code transcript, analyzed from screenshots on 2026-08-25/26. Anchors below were verified against this worktree on 2026-09-02.

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

| Element                      | State                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Header = name + description  | Have it — `displayName` + `summary`, `packages/app/src/tool-calls/presentation.ts:70`                                     |
| Height clamp                 | Have it — `maxHeight ?? 300`, `packages/app/src/components/tool-call-details.tsx:751`                                     |
| "does this tool have detail" | Have it, and it is wired — `canOpenDetails` gates the toggle and the detail renderer, `message.tsx:3207,3209`             |
| Split diff renderer          | Pairing logic exists, wrapped in git-review numbering — `buildSplitDiffRows`, `packages/app/src/utils/diff-layout.ts:251` |
| Chat diff path               | Hardcoded unified — `useDiffLines` → `parseUnifiedDiff`, `tool-call-details.tsx:135`                                      |
| Rail + status dot            | Missing. Paseo resolves a per-tool icon (`presentation.ts:72`), so the left edge is ragged by glyph width                 |
| Tighter markdown scale       | Precedent exists — `createCompactMarkdownStyles`, `packages/app/src/styles/markdown-styles.ts:360`                        |
| Content width                | `MAX_CONTENT_WIDTH = 820`, `packages/app/src/constants/layout.ts:15`. Measure is fine; not a problem to fix               |

`buildSplitDiffRows` is consumed only by `packages/app/src/git/diff-document/model.ts:196` — the git panes. See slice 1 for why the chat path cannot call it as-is.

## Strategy: fix the renderers, add one setting

Slices 1, 2a and 4 lose no information and need no setting — they are strictly better renderings of the same data. Slice 3 changes visual identity and is opt-in. Slice 2b removes an affordance and is not unconditional; see slice 2.

Side-by-side needs width, so slice 1 gates on `useIsCompactFormFactor()` from `@/constants/layout`, not on a user preference. Compact keeps unified. This is the existing convention for layout capability and avoids a settings key nobody asked for.

Slice 3 is opt-in, but not as a third `ToolCallDetailLevel`. That enum decides **how much** of the turn survives — `"detailed"` passes stream items through while `"overview"` groups and replaces tool-call runs (`packages/app/src/tool-calls/detail-level/projection.ts:23,36`). Rail placement and marker shape are independent of that projection, so a third value would mix two responsibilities and still could not express both density choices. Separate key:

```ts
export type ChatTranscriptStyle = "cards" | "trace";
```

Four sites in `packages/app/src/hooks/use-settings/storage.ts`, each with a neighbour to copy: the union near line 35, the `AppSettings` field near line 85, `DEFAULT_CLIENT_SETTINGS` near line 136 (`"cards"` = today's rendering), and the schema near line 223.

Do not copy the neighbouring `.optional().catch(...)` shape. `readAppSettings` normalizes a stored blob directly (`storage.ts:345`) instead of merging it over `DEFAULT_CLIENT_SETTINGS`, and `.optional()` accepts absence so `.catch` never fires for a missing key — verified against zod 4.4.3, where `z.enum([...]).optional().catch("cards")` parses `{}` to `{}` while `z.enum([...]).catch("cards")` parses it to `"cards"`. That is why every optional enum already in this file repeats its default in the normalize transform (`sidebarChecksDisplay` at `storage.ts:258-262` has no legacy predecessor and still needs one). Dropping `.optional()` keeps the default in one place:

```ts
chatTranscriptStyle: z.enum(["cards", "trace"]).catch("cards"),
```

No value migration. `compactToolCalls` needed one (`storage.ts:263`) because it was an older persisted form of a preference the user had actually set. `chatTranscriptStyle` has no predecessor, so an absent key legitimately means `"cards"`. Cover three cases in `storage.test.ts`: key absent, persisted `"trace"`, unknown future value.

No protocol change either — settings live under `APP_SETTINGS_KEY` in client storage and never cross the wire.

Renderers take one boolean. `useSettings` is a selector, so the two renderers that vary — the tool-call badge and the user message — read `chatTranscriptStyle` where they use it rather than threading a prop through the memoized row tree. A two-field `TranscriptPresentation { rail, nodeMarker }` record is not worth it today: the fields are perfectly correlated (cards = no rail + icons, trace = rail + dots), so it is one binary decision wearing two names, which the zero-complexity rule in `docs/coding-standards.md:9` rules out. Add a field when a style varies it independently; promote to a preset module if the discriminator ever reaches three or more renderers (`coding-standards.md:73`).

The picker copies `TOOL_CALL_DETAIL_LEVELS` (`packages/app/src/screens/settings/appearance/appearance-section.tsx:274`), which is already a `readonly` array feeding a `DropdownMenu`. It mounts in the "Detail level" section next to `ToolCallDetailRow` (`appearance-section.tsx:700`), and needs the label key in all nine locales under `packages/app/src/i18n/resources/` — `resources.test.ts` enforces parity.

## Slices

| #   | Slice                                     | Effort | Risk   |
| --- | ----------------------------------------- | ------ | ------ |
| 2a  | Read range in the header row              | S      | low    |
| 4   | Stop markdown block margins from stacking | M      | low    |
| 1   | Side-by-side diff in chat Edit rows       | S      | low    |
| 3   | Rail plus status dots                     | M      | medium |
| 2b  | Suppress the shell chevron (trace only)   | S      | low    |

Order: **2a → 4 → 1 → 3 → 2b**. 2a establishes the row content slice 3 styles. 4 is independent. 1 extracts the pairing algorithm rather than calling `buildSplitDiffRows` directly. 3 consumes the corrected headers, spacing and diff renderer. 2b comes last because it depends on trace's wrapping header — see slice 2.

### Slice 1 — side-by-side diff in chat

`useDiffLines` (`tool-call-details.tsx:135`) returns a flat local `DiffLine[]` and the `detail.type === "edit"` branch (`tool-call-details.tsx:664`) renders it unified. Pair the lines into two columns when the form factor is wide, keeping unified for compact.

**The columns are unnumbered.** Chat shows no gutter numbers today for any edit — `DiffLine` has no line-number field (`tool-call-parsers.ts:9-16`) and `parseUnifiedDiff` pushes `@@` through as a header string without parsing `oldStart`/`newStart` (`tool-call-parsers.ts:221-224`). Numbering would be a new feature, and it cannot be delivered evenly: Codex sends `unifiedDiff` (`codex/tool-call-mapper.ts:453`), while OpenCode's plain edit branch sets `unifiedDiff: undefined` (`opencode/tool-call-detail-parser.ts:236`) and OMP, Pi and ACP populate `oldString`/`newString`, which carry no absolute offsets (`agent-types.ts:215`). Numbering where offsets happen to exist would give the same UI different chrome per provider. Diffs are also `truncateDiffText`'d server-side (`tool-call-detail-primitives.ts:562`), so numbers would look authoritative over cut content.

Side-by-side alignment is the scannability win and is separable from numbering. Ship the alignment; treat numbered gutters as a later slice that needs offsets in the protocol first.

Do not call `buildSplitDiffRows` directly. It takes a whole `ParsedDiffFile` (`diff-layout.ts:251`) requiring file flags, counts and hunks with `oldStart`/`oldCount`/`newStart`/`newCount` (`packages/protocol/src/messages.ts:2520`) — an object the git pane already holds (`git/diff-document/model.ts:191`) and chat cannot construct — and its output carries `reviewTarget` (`diff-layout.ts:98`), git-review machinery chat has no use for.

Extract the pairing algorithm instead. It buffers removals and additions and zips them by index (`diff-layout.ts:263-300`) and never compares line numbers, so it lifts cleanly over a plain ordered line list. It is well covered by `packages/app/src/utils/diff-layout.test.ts:52`, so the extraction is cheap to verify against current behavior.

The absent-side hatching has no existing equivalent — `SplitDiffRow` already models `left: … | null` / `right: … | null` (`diff-layout.ts:84`), so the null side is where the hatch goes.

Acceptance: an Edit tool call on desktop renders two aligned columns with hatching where a side is absent; the same call on a phone renders unchanged; an OpenCode edit and a Codex edit render the same chrome; no gutter shows a number.

### Slice 2 — fold the payload into the header row

The original framing was wrong twice.

First, no tool call draws an unconditional card: `detailContent = hasDetailContent && isExpanded` (`packages/app/src/components/message.tsx:2721`) and `isExpanded` starts at `defaultExpanded ?? false` (`message.tsx:3080`). The only caller passing `defaultExpanded` is the reasoning block at `packages/app/src/agent-stream/view.tsx:727`, from `autoExpandReasoning`, which defaults to `false`. Every tool row is already header-only until clicked — `qa-evidence/chat-trace/02-edit-row-collapsed.png`.

Second, `canOpenDetails` is not dead code. It gates both the row action and the detail renderer at `message.tsx:3207,3209`.

One real exception: a `plan` detail returns `<PlanCard>` at `message.tsx:3190` before the badge is reached, so it is always a card with no header row and no toggle. Leave it — a plan is content, closer to the reference's unboxed final answer than to a tool payload.

**2a — enrich the header.** `Read` should read `Read settings.json (lines 53-66)` without expanding. `offset` and `limit` already exist on the read detail (`agent-types.ts:209`), so this is additive and ships unconditionally.

**2b — the shell chevron. Trace only.** `hasMeaningfulToolCallDetail` returns `true` unconditionally for `type: "shell"` (`packages/app/src/utils/tool-call-detail-state.ts:71`), which reads like a bug that shows a chevron over an empty card. The card is not empty: the shell detail always renders the command and only appends output when present, and the command is selectable and horizontally scrollable (`tool-call-details.tsx:151`). Under `"cards"` the header cannot substitute — the shell summary _is_ the command (`packages/protocol/src/tool-call-display.ts:87`) and the secondary label is clamped to `numberOfLines={1}` (`message.tsx:2372`), so removing the chevron there costs inspection and copying of long or multiline commands, and on compact removes the action that opens the detail sheet.

Trace supplies the affordance the removal needs, but not in the header. The card carries the command — see the preview card in slice 3 — so the header drops the summary for shell rows rather than printing the command twice, and the row reads `Shell` over an IN/OUT card. When there is no output and no error the card is the whole payload, so the chevron goes. `hasMeaningfulToolCallDetail` is left alone; it answers its own question correctly.

One structural note: `renderDetails` used to be gated on the same value as the toggle, so suppressing the chevron also suppressed the card. Whether a row can expand and whether it has a card are now separate questions.

Acceptance: a `Read` call names its line range in the header row. Under `"cards"`, shell rows are unchanged. Under `"trace"`, a shell call shows its command in the card rather than the header; one with no output and no error has no chevron.

### Slice 3 — rail plus status dots

Replace `input.resolveIcon(...)` (`presentation.ts:72`) at the call site with a uniform dot colored by status, and draw one continuous line behind the node column. `ToolCallStatus` (`presentation.ts:11`) already carries `executing | running | completed | failed | canceled` — the red dot for denied/failed is the half that carries the most information, and Paseo has the state for it today.

The dot is red for more than `status === "failed"`. Nothing maps a non-zero shell exit onto that status — the exit code rides on the detail (`tool-call-detail-primitives.ts:116`) — so a failing test run would otherwise read as a clean call. `hasErrored` covers both and drives only the dot; `isError` keeps its narrower meaning so a `grep` that exits 1 does not sprout a warning triangle under `"cards"`.

This changes what every user sees, so it ships behind `chatTranscriptStyle` with `"cards"` as the default.

The user message moves onto the rail as an outlined card. Today it is a right-aligned `surface3` bubble with no border (`userMessageStylesheet.bubble`, `message.tsx:328`), and the container is `justifyContent: "flex-end"`, so this is three changes at once: alignment, fill to outline, and width. It is the largest visual change in the plan and the reason the style is opt-in. Under `"cards"` the bubble is untouched. `disableOuterSpacing` is already threaded through `UserMessage` for embedded rendering, so the alignment switch has a seam; the fill-to-outline half is new style, not new structure.

**A payload tool's card is visible by default, clamped.** A `Bash` row is its IN/OUT and an `Edit` row is its diff, so hiding that behind a chevron leaves the row saying almost nothing. Trace previews `shell` and `edit` cards from the start and expands to full on click; `read` and everything else stay header-only, which is what keeps the cheap rows cheap.

The clamp counts lines, not pixels. `maxHeight` was the obvious lever and it is the wrong one: it slices whatever line it lands in, so a card ends on a half-rendered row. `previewLines` truncates the text instead, and IN and OUT are clamped independently so a long command cannot crowd out the output. The card also indents to the content column, or it paints over the rail.

The mock's shell command (`mock-load-test-agent.ts:610`) is deliberately wider than the card so the overflow path stays covered; narrowing the viewport is not a substitute, because compact swaps the inline card for a sheet. Compact also drops the IN/OUT gutter and falls back to the `$` prompt — 28px of label is a poor trade on a phone.

Whole-line truncation is silent, so the card needs to say it was cut — the reference's mid-glyph slice was doing that job. `takeLines` reports whether it dropped anything, so the `Click to expand` pill needs no measurement pass. A shell card labels its two streams in a fixed-width gutter; the labels sit outside the selectable node so copying the card yields the command and output without them.

**Trace plus overview rolls failure up to the group.** Both settings are independent, so all four combinations are reachable — a user on `"overview"` who opts into trace gets one. Overview is a separate renderer that hardcodes a wrench marker (`packages/app/src/tool-calls/detail-level/overview/view.tsx:97,114`), and `OverviewToolCallGroup` exposes only `isLoading` (`overview/model.ts:16-21`), so a failed call inside a collapsed group cannot produce the red dot on its own.

The status is already in the loop. `buildOverviewGroup` iterates every call and reads `descriptor.status` to compute `isLoading` (`overview/model.ts:43`), and `describeToolCall` returns `status` and `error` for both payload sources (`detail-level/grouping.ts:40-60`). Add `hasFailure` beside it:

- `hasFailure ||= descriptor.status === "failed";` in the existing loop, and one field on `OverviewToolCallGroup`.
- The `icon` slot on `ExpandableBadge` carries the dot under trace and keeps the wrench under cards — the same swap this slice already makes for ungrouped rows.

`failed` drives red; `canceled` does not. `failed` is the only status carrying `error: unknown` (`packages/protocol/src/agent-types.ts:318-321`); `canceled` carries `error: null` (`:323-326`), and a stopped call is not a defect to hunt. While the run is loading, the loading state wins; red applies once it settles.

The group dot is a signpost. Expanding, or the sheet on compact, still shows each call's own status, so the failing call stays identifiable one level down.

Own the four combinations in test. This need not be four full platform suites, but trace+overview needs behavioral coverage beyond the default and reference states — the capture spec currently exercises one default rendering (`packages/app/e2e/browser/chat-trace-baseline.spec.ts:15`).

`StreamItemWrapper` draws the rail — one segment per stream item, from the single element that
owns the gap between items. Nodes draw only their marker: a status dot on a tool row, a grey dot
on prose and user messages, each indented past the column by `TRANSCRIPT_MARKER_COLUMN_WIDTH`.

A per-node rail cannot work, and the reason is worth keeping. The gap between items lives outside
every node, so a rail drawn inside one can never reach across it. That failure looks like a
too-small overshoot, which invites a bigger constant, and the constant then breaks again whenever
spacing changes — a preview card, a scrollbar, a new node kind. Holding the gap as padding on the
wrapper puts it inside the box that draws the rail, so `top: 0` / `bottom: 0` spans item plus gap
and consecutive segments meet with nothing to bridge. No constant, nothing to retune.

Acceptance: the left edge of a turn is a straight line, prose and user message included; the user
message is a full-width outline on that edge; a denied tool call is identifiable without reading
its output, at both detail levels.

The marker hangs off a zero-size anchor placed as the node's first in-flow child, so Yoga resolves
every ancestor's padding and the offset only describes the content. Positioning it from the node
box instead meant restating each spacing variant's padding by hand, and the variant nobody updated
left its dot floating — `compactTop` and a first-in-group user message both did. What remains in
the offset is what the first line adds above itself, which depends on the style governing that
line: `markdownLeadingKind` picks it and `markdownLeadingLineHeight` sizes it, so a heading-led
node and a prose node get different numbers from one source. Lists and code fences report as prose
and land about 3px high — their first line sits inside a wrapper whose padding this does not model.

`chat-trace-style.spec.ts` asserts every dot centre within 4px of its node's first line. Assert on
one node kind alone and the other kind floats undetected.

### Slice 4 — margin stacking

Independent of everything above. The stacked band is real; the earlier "adjacent margins fail to collapse" explanation was not. React Native never collapses margins — Yoga sums them, confirmed against the installed Yoga 3.2.1: a 12px bottom margin followed by a 24px top margin yields 36px. The styles behave exactly as authored.

There are also two owners, not one. Assistant markdown is split into separate `MarkdownRenderer` instances (`message.tsx:1905`) and every non-final block gets another 12px bottom margin (`message.tsx:1931`). A table followed by an `h2` sums a table margin, a wrapper margin, and a heading top margin:

| Site                                             | Value             |
| ------------------------------------------------ | ----------------- |
| `markdown-styles.ts:48` `paragraph.marginBottom` | `spacing[3]` = 12 |
| `markdown-styles.ts:220` `table.marginVertical`  | `spacing[3]` = 12 |
| `message.tsx:1931` per-block wrapper             | 12                |
| `markdown-styles.ts:80` `heading2.marginTop`     | `spacing[6]` = 24 |

`heading2.paddingBottom` (`:85`) and `heading2.marginBottom` (`:81`) sit _below_ the heading and are not part of the preceding gap.

**Fix shape: give adjacency one structural owner.** The block container should own inter-block spacing, optionally varying it by the following block's kind, and top-level markdown nodes should stop adding competing outer margins. A `body.gap` cannot fix this alone, because adjacent assistant blocks are separate renderer instances. A margin-bottom-only convention still requires removing the wrapper margin and finding another way to express the larger pre-heading gap. Editing only the style properties leaves stacking elsewhere or changes shared markdown surfaces that are not the chat transcript — note `createCompactMarkdownStyles` carries its own `heading2`/`paragraph` at `markdown-styles.ts:380,396`.

`heading1`/`heading2` also carry `borderBottomWidth: 1` (lines 70, 83), which is the rule under headings in the app today. Whether that rule stays is a separate taste call — leave it.

Prior art: [#2329](https://github.com/getpaseo/paseo/issues/2329) documented the symptom with the same anchors and was closed under the bugs-only intake policy.

The fix lands in the shared markdown styles, so the plan-card, file-pane markdown preview and pull-request panel change too. That is deliberate: the stacking is a defect on every surface, and a chat-only copy of the style object would cost more than it saves.

Acceptance: a table immediately followed by an `h2` produces one gap, not the sum of three owners; every markdown surface keeps the same pre-heading space it has today.

One node needs an explicit zero rather than silence. `react-native-markdown-display` merges its own
defaults under ours per key, and its `paragraph` carries `marginTop: 10` / `marginBottom: 10`.
Omitting those keys inherits them, so `body.gap` was never the single owner it claimed to be: every
paragraph sat 10px lower than the gap accounted for, which is what pushed the trace marker off its
first line. Every other block node's default has no vertical margin, so paragraph is the only one.
A test that asserts absence cannot see this — assert the zero.

## Non-goals

- **No-wrap plus pane-level horizontal scroll.** The reference clips monospace and scrolls the whole transcript sideways. Worst cost/benefit in the set, fights `packages/app/src/agent-stream/web-virtualization.ts`, and breaks compact form factors.
- **Routing diffs to the side panel.** Dropped. An early reading of the reference had diffs opening an editor tab; the second screenshot disproved it.
- **Narrowing the measure.** `MAX_CONTENT_WIDTH = 820` is already the binding constraint. The first screenshot suggesting otherwise was 2× DPR.
- **A new theme.** Palettes cannot express any of this.
- **Changing defaults toward "collapse the process."** Five Discussions ask for that ([#3352](https://github.com/getpaseo/paseo/discussions/3352), [#3520](https://github.com/getpaseo/paseo/discussions/3520), [#3575](https://github.com/getpaseo/paseo/discussions/3575), [#3444](https://github.com/getpaseo/paseo/discussions/3444), [#2690](https://github.com/getpaseo/paseo/discussions/2690)) and the reference layout does the opposite — it shows everything, bounded. Both are coherent; they are not compatible defaults. This plan takes the scannability and leaves the default alone.

## Observed baseline

Captured 2026-08-28 from `packages/app/e2e/browser/chat-trace-baseline.spec.ts`, which drives the mock provider's realistic cycle — `read → grep → edit → bash` plus prose, the same node vocabulary as the reference. Screenshots in `qa-evidence/chat-trace/`.

**The user message is a bubble, not a card.** `userMessageStylesheet.bubble` (`message.tsx:328`) is `backgroundColor: surface3` with `borderRadius["2xl"]`, a squared `borderTopRightRadius`, and no border; the container is `justifyContent: "flex-end"`. So the reference's bordered full-width card is not a border to add — it is flip right-aligned fill to left-aligned outline, which moves the user message onto the rail. Biggest identity change in the set, and the reason slice 3 is opt-in.

**A collapsed tool row is already close to the reference.** `Edit packages/app/src/hooks/use-scroll-anchor.ts` renders as icon plus name plus path on one line, with the diff behind a click. The gap to the reference is the marker glyph and the missing rail, not the row shape.

**The expanded diff already has syntax highlighting**, unified, with a `@@` hunk header — so slice 1 is a layout change to something that already renders well, not new rendering.

## Decisions

- **The trace style moves the user message onto the rail as an outlined card.** Settled 2026-08-28. Keeping it right-aligned was the smaller change but leaves the rail reading as two columns, which is the one thing the reference layout is for. Scoped in slice 3.
- **The user message stays a bubble under `"cards"`.** The whole point of the separate key is that nobody is opted into this by upgrading.
- **`plan` keeps its unconditional card.** The only tool detail that renders one; see slice 2.
- **`chatTranscriptStyle` stays a separate key from `ToolCallDetailLevel`.** Settled 2026-09-02. The two axes are different in code — overview replaces stream items, trace changes layout — so a third enum value would mix responsibilities. The cost is a real 2×2 matrix, owned in slice 3.
- **Renderers take a boolean, not a preset record.** Settled 2026-09-02. `rail` and `nodeMarker` are correlated today, so the record is one decision with two names.
- **The shell chevron stays until a header can carry the full command.** Settled 2026-09-02. Removing it loses inspect and copy on multiline commands. Trace supplies that header by wrapping the summary, so 2b ships there and nowhere else.
- **Split diff columns are unnumbered, and slice 1 extracts the pairing algorithm.** Settled 2026-09-02. Chat has never shown gutter numbers, and most providers send no offsets, so numbering would be new, uneven, and provider-dependent. Scoped in slice 1.
- **A trace+overview group shows red when any call in it failed.** Settled 2026-09-02. `canceled` stays neutral because it carries no error. Scoped in slice 3.
- **Payload cards preview by default; the clamp counts lines.** Settled 2026-09-02. A pixel clamp leaves a half-rendered row, which reads as a rendering bug rather than as truncation. Scoped in slice 3.
- **A non-zero shell exit is red.** Settled 2026-09-02. It costs false positives — `grep` with no match, `git diff --exit-code` — but a failing test run reading as a clean call is the worse miss. Dot only; `isError` is unchanged.

## Open questions

None. Both closed 2026-09-02 — see Decisions. Nothing blocks 2a or 4.
