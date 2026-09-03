import { FONT_SIZE, type Theme } from "./theme";
import { isWeb } from "@/constants/platform";

const webSelectableTextStyle = isWeb ? { userSelect: "text" as const } : {};

function contentHeadingSize(contentSize: number, tier: keyof typeof FONT_SIZE): number {
  return Math.round(contentSize * (FONT_SIZE[tier] / FONT_SIZE.base));
}

function contentHeadingLineHeight(contentSize: number, tier: keyof typeof FONT_SIZE): number {
  return Math.round(contentHeadingSize(contentSize, tier) * 1.3);
}

/**
 * Which style governs the first rendered line of a markdown block. Callers that have to place
 * something against that line — the trace transcript's node marker — need the block's own line
 * height and lead-in margin, and only this module knows which style a block resolves to.
 *
 * Lists, code fences and tables all report "body": their first line sits inside a wrapper whose
 * own padding this does not model, so a caller lands a few pixels high on those. Prose and
 * headings, which is nearly every block, are exact.
 */
export type MarkdownLeadingKind =
  | "body"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6";

const LEADING_HEADING_TIER: Record<Exclude<MarkdownLeadingKind, "body">, keyof typeof FONT_SIZE> = {
  heading1: "4xl",
  heading2: "3xl",
  heading3: "2xl",
  heading4: "xl",
  heading5: "lg",
  heading6: "lg",
};

/**
 * The line height the block's first rendered line will have. Only `contentSize` varies at
 * runtime — the heading ramp is the static FONT_SIZE ratio — so a caller inside a Unistyles
 * stylesheet factory reads exactly one theme value and stays tracked.
 */
export function markdownLeadingLineHeight(kind: MarkdownLeadingKind, contentSize: number): number {
  if (kind === "body") return Math.round(contentSize * 1.4);
  return contentHeadingLineHeight(contentSize, LEADING_HEADING_TIER[kind]);
}

const ATX_HEADING = /^(#{1,6})\s/;

export function markdownLeadingKind(block: string): MarkdownLeadingKind {
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = ATX_HEADING.exec(trimmed);
    return match ? (`heading${match[1].length}` as MarkdownLeadingKind) : "body";
  }
  return "body";
}

const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * Whether the block renders a rule and nothing else. A thematic break has no line of text, so a
 * caller that puts a marker on a block's first line has nothing to aim at and should skip it
 * rather than leave one floating beside a 1px rule.
 */
export function markdownBlockIsRuleOnly(block: string): boolean {
  let sawRule = false;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!THEMATIC_BREAK.test(line)) return false;
    sawRule = true;
  }
  return sawRule;
}

/**
 * Creates comprehensive markdown styles for react-native-markdown-display.
 *
 * Usage:
 *   const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
 *   <Markdown style={markdownStyles} markdownit={parser}>{content}</Markdown>
 *
 * Always pass `markdownit` from `@/utils/markdown-parser`. Omit it and
 * react-native-markdown-display builds its own parser with `typographer: true`,
 * which rewrites a literal `(c)` as ©.
 */
export function createMarkdownStyles(theme: Theme) {
  return {
    // =========================================================================
    // BASE STYLES
    // =========================================================================

    body: {
      ...webSelectableTextStyle,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      // Prose line-height scales with the content size, not the
      // code-size-coupled lineHeight.diff token used by code/diff surfaces.
      lineHeight: Math.round(theme.fontSize.content * 1.4),
      // Single owner for the gap between top-level blocks. React Native never collapses
      // margins, so block nodes carry no vertical margin of their own; a heading adds only
      // the extra space it wants above this gap.
      gap: theme.spacing[3],
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    text: {
      ...webSelectableTextStyle,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    paragraph: {
      // react-native-markdown-display's own default paragraph style carries marginTop/
      // marginBottom of 10, and it merges its defaults under ours per key. Omitting these
      // keys does not drop them — it inherits them, which double-counts against body.gap.
      // Every other block node's default has no vertical margin, so only this one needs it.
      marginTop: 0,
      marginBottom: 0,
      flexWrap: "wrap" as const,
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      justifyContent: "flex-start" as const,
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    // =========================================================================
    // HEADINGS
    // =========================================================================

    heading1: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "4xl"),
      fontWeight: theme.fontWeight.bold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[3],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "4xl"),
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: theme.spacing[2],
    },

    heading2: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "3xl"),
      fontWeight: theme.fontWeight.bold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[3],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "3xl"),
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: theme.spacing[2],
    },

    heading3: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "2xl"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[1],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "2xl"),
    },

    heading4: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "xl"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[1],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "xl"),
    },

    heading5: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
    },

    heading6: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foregroundMuted,
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
      textTransform: "uppercase" as const,
      letterSpacing: 0.5,
    },

    // =========================================================================
    // TEXT FORMATTING
    // =========================================================================

    strong: {
      ...webSelectableTextStyle,
      fontWeight: theme.fontWeight.medium,
    },

    em: {
      ...webSelectableTextStyle,
      fontStyle: "italic" as const,
    },

    s: {
      ...webSelectableTextStyle,
      textDecorationLine: "line-through" as const,
      color: theme.colors.foregroundMuted,
    },

    link: {
      ...webSelectableTextStyle,
      color: theme.colors.accentBright,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    blocklink: {
      ...webSelectableTextStyle,
      color: theme.colors.accentBright,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    // =========================================================================
    // CODE
    // =========================================================================

    code_inline: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      paddingHorizontal: theme.spacing[1],
      paddingVertical: 2,
      borderRadius: theme.borderRadius.md,
      borderWidth: 0,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
    },

    code_block: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      padding: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
    },

    fence: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      padding: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
    },

    pre: {},

    // =========================================================================
    // TABLES
    // =========================================================================

    table: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
    },

    thead: {
      backgroundColor: theme.colors.surface2,
    },

    tbody: {},

    th: {
      ...webSelectableTextStyle,
      padding: theme.spacing[2],
      borderBottomWidth: 1,
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      textAlign: "left" as const,
    },

    tr: {
      borderBottomWidth: 1,
      borderColor: theme.colors.border,
      flexDirection: "row" as const,
    },

    td: {
      ...webSelectableTextStyle,
      padding: theme.spacing[2],
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      flex: 1,
    },

    // =========================================================================
    // LISTS
    // =========================================================================

    bullet_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    ordered_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    list_item: {
      marginBottom: theme.spacing[1],
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      flexShrink: 1,
    },

    bullet_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    ordered_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    bullet_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.content,
      lineHeight: Math.round(theme.fontSize.content * 1.4),
    },

    ordered_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.content,
      fontWeight: theme.fontWeight.normal,
      lineHeight: Math.round(theme.fontSize.content * 1.4),
      minWidth: 12,
    },

    // =========================================================================
    // BLOCKQUOTE
    // =========================================================================

    blockquote: {
      backgroundColor: theme.colors.surface1,
      color: `${theme.colors.foreground}cc`,
      borderLeftWidth: 4,
      borderLeftColor: theme.colors.surface2,
      paddingHorizontal: theme.spacing[4],
      paddingTop: theme.spacing[3],
      paddingBottom: 0,
      borderRadius: theme.borderRadius.md,
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
    },

    // =========================================================================
    // HORIZONTAL RULE
    // =========================================================================

    hr: {
      backgroundColor: theme.colors.border,
      height: 1,
    },

    // =========================================================================
    // IMAGES
    // =========================================================================

    image: {
      borderRadius: theme.borderRadius.md,
    },

    // =========================================================================
    // BREAKS
    // =========================================================================

    hardbreak: {
      height: theme.spacing[2],
    },

    softbreak: {},
  };
}

/**
 * Creates a smaller variant of markdown styles for compact UI elements
 * like thought bubbles, tooltips, or side panels.
 */
export function createCompactMarkdownStyles(theme: Theme) {
  const baseStyles = createMarkdownStyles(theme);

  return {
    ...baseStyles,

    body: {
      ...baseStyles.body,
      fontSize: theme.fontSize.content,
      lineHeight: Math.round(theme.fontSize.content * 1.4),
      gap: theme.spacing[2],
    },

    heading1: {
      ...baseStyles.heading1,
      fontSize: contentHeadingSize(theme.fontSize.content, "2xl"),
      marginTop: theme.spacing[2],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "2xl"),
    },

    heading2: {
      ...baseStyles.heading2,
      fontSize: contentHeadingSize(theme.fontSize.content, "xl"),
      marginTop: theme.spacing[1],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "xl"),
    },

    heading3: {
      ...baseStyles.heading3,
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      marginTop: theme.spacing[1],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
    },

    paragraph: {
      ...baseStyles.paragraph,
    },

    code_inline: {
      ...baseStyles.code_inline,
      fontSize: theme.fontSize.code,
    },

    code_block: {
      ...baseStyles.code_block,
      fontSize: theme.fontSize.code,
      padding: theme.spacing[2],
    },

    fence: {
      ...baseStyles.fence,
      fontSize: theme.fontSize.code,
      padding: theme.spacing[2],
    },
  };
}
