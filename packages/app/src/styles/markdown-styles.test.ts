import { describe, expect, it } from "vitest";
import {
  createCompactMarkdownStyles,
  createMarkdownStyles,
  markdownLeadingKind,
  markdownLeadingLineHeight,
} from "./markdown-styles";
import { darkTheme } from "./theme";

describe("createMarkdownStyles", () => {
  it("uses the content size for conversation prose and list markers", () => {
    const styles = createMarkdownStyles(darkTheme);
    const proseLineHeight = Math.round(darkTheme.fontSize.content * 1.4);

    expect(styles.body).toMatchObject({
      fontSize: darkTheme.fontSize.content,
      lineHeight: proseLineHeight,
    });
    expect(styles.bullet_list_icon).toMatchObject({
      fontSize: darkTheme.fontSize.content,
      lineHeight: proseLineHeight,
    });
    expect(styles.ordered_list_icon).toMatchObject({
      fontSize: darkTheme.fontSize.content,
      lineHeight: proseLineHeight,
    });
  });

  it("applies shrink-and-wrap constraints to long markdown text and links", () => {
    const styles = createMarkdownStyles(darkTheme);

    expect(styles.body).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      width: "100%",
    });

    expect(styles.paragraph).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      width: "100%",
      flexWrap: "wrap",
    });

    expect(styles.text).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
    });

    expect(styles.link).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
    });

    expect(styles.blocklink).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
    });
  });

  it("keeps assistant markdown text selectable on web", () => {
    const styles = createMarkdownStyles(darkTheme);

    expect(styles.body).toMatchObject({
      userSelect: "text",
    });
    expect(styles.text).toMatchObject({
      userSelect: "text",
    });
    expect(styles.heading1).toMatchObject({
      userSelect: "text",
    });
    expect(styles.link).toMatchObject({
      userSelect: "text",
    });
    expect(styles.code_inline).toMatchObject({
      userSelect: "text",
    });
    expect(styles.code_block).toMatchObject({
      userSelect: "text",
    });
    expect(styles.fence).toMatchObject({
      userSelect: "text",
    });
    expect(styles.bullet_list_icon).toMatchObject({
      userSelect: "text",
    });
    expect(styles.ordered_list_icon).toMatchObject({
      userSelect: "text",
    });
  });

  it("uses the mono font-size token directly for inline and block code", () => {
    const styles = createMarkdownStyles(darkTheme);
    const compactStyles = createCompactMarkdownStyles(darkTheme);

    expect(styles.code_inline).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(styles.code_inline).not.toHaveProperty("lineHeight");
    expect(styles.code_block).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(styles.fence).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(compactStyles.code_inline).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(compactStyles.code_inline).not.toHaveProperty("lineHeight");
  });

  it("scales Markdown headings from content size with safe line heights", () => {
    const largeContentTheme = {
      ...darkTheme,
      fontSize: { ...darkTheme.fontSize, content: 21 },
    };
    const styles = createMarkdownStyles(largeContentTheme);

    expect(styles.heading1.lineHeight).toBeGreaterThan(styles.heading1.fontSize);
    expect(styles.heading2.lineHeight).toBeGreaterThan(styles.heading2.fontSize);
    expect(styles.heading3.lineHeight).toBeGreaterThan(styles.heading3.fontSize);
  });

  it("keeps blockquotes quiet with a square left edge", () => {
    const styles = createMarkdownStyles(darkTheme);

    expect(styles.blockquote).toMatchObject({
      backgroundColor: darkTheme.colors.surface1,
      color: `${darkTheme.colors.foreground}cc`,
      borderLeftColor: darkTheme.colors.surface2,
      paddingTop: darkTheme.spacing[3],
      paddingBottom: 0,
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
    });
    expect(styles.text).not.toHaveProperty("color");
  });

  it("gives the gap between top-level blocks a single owner", () => {
    const styles = createMarkdownStyles(darkTheme);

    // React Native never collapses margins, so two block nodes that each carry one would
    // sum. body.gap owns the rhythm and block nodes carry no vertical margin at all.
    expect(styles.body.gap).toBe(darkTheme.spacing[3]);
    // paragraph is the one node whose library default carries vertical margins, and the
    // library merges its defaults under ours per key. Absence would inherit them, so this
    // one has to override with an explicit zero rather than say nothing.
    expect(styles.paragraph.marginTop).toBe(0);
    expect(styles.paragraph.marginBottom).toBe(0);
    for (const key of [
      "table",
      "fence",
      "code_block",
      "pre",
      "blockquote",
      "hr",
      "image",
      "heading1",
      "heading2",
      "heading3",
      "heading4",
      "heading5",
      "heading6",
    ] as const) {
      expect(styles[key]).not.toHaveProperty("marginVertical");
      expect(styles[key]).not.toHaveProperty("marginBottom");
    }
  });

  it("lets a heading add extra space above the shared gap without summing two margins", () => {
    const styles = createMarkdownStyles(darkTheme);
    const gap = styles.body.gap;

    // A table followed by an h2 is one gap plus the heading's extra, not the sum of both
    // blocks' margins. 24px total preserves today's pre-heading space.
    expect(gap + styles.heading2.marginTop).toBe(darkTheme.spacing[6]);
    expect(gap + styles.heading1.marginTop).toBe(darkTheme.spacing[6]);
    expect(gap + styles.heading3.marginTop).toBe(darkTheme.spacing[4]);
    expect(styles.heading5).not.toHaveProperty("marginTop");
    expect(styles.heading6).not.toHaveProperty("marginTop");
  });

  it("keeps the compact variant on its own tighter rhythm", () => {
    const styles = createCompactMarkdownStyles(darkTheme);
    const gap = styles.body.gap;

    expect(gap).toBe(darkTheme.spacing[2]);
    expect(gap + styles.heading1.marginTop).toBe(darkTheme.spacing[4]);
    expect(gap + styles.heading2.marginTop).toBe(darkTheme.spacing[3]);
    expect(styles.paragraph.marginBottom).toBe(0);
  });

  it("reports the style that governs a block's first rendered line", () => {
    expect(markdownLeadingKind("Just prose.")).toBe("body");
    expect(markdownLeadingKind("# Title\n\nBody")).toBe("heading1");
    expect(markdownLeadingKind("###### Deep")).toBe("heading6");
    // Leading blank lines survive block splitting, and the heading can sit under them.
    expect(markdownLeadingKind("\n\n## Later")).toBe("heading2");
    // Seven hashes is not a heading, and a hash without a space is not one either.
    expect(markdownLeadingKind("####### Nope")).toBe("body");
    expect(markdownLeadingKind("#hashtag")).toBe("body");
    // A heading below the first line belongs to a later line, not this block's lead.
    expect(markdownLeadingKind("Prose first\n# Then a heading")).toBe("body");
    expect(markdownLeadingKind("")).toBe("body");
  });
});

describe("markdownLeadingLineHeight", () => {
  it("matches the line height the block's own style renders with", () => {
    const styles = createMarkdownStyles(darkTheme);
    const content = darkTheme.fontSize.content;

    expect(markdownLeadingLineHeight("body", content)).toBe(styles.body.lineHeight);
    expect(markdownLeadingLineHeight("heading1", content)).toBe(styles.heading1.lineHeight);
    expect(markdownLeadingLineHeight("heading2", content)).toBe(styles.heading2.lineHeight);
    expect(markdownLeadingLineHeight("heading3", content)).toBe(styles.heading3.lineHeight);
    expect(markdownLeadingLineHeight("heading4", content)).toBe(styles.heading4.lineHeight);
    expect(markdownLeadingLineHeight("heading5", content)).toBe(styles.heading5.lineHeight);
    expect(markdownLeadingLineHeight("heading6", content)).toBe(styles.heading6.lineHeight);
  });

  it("pins the lead-in margin the trace marker restates per heading level", () => {
    const styles = createMarkdownStyles(darkTheme);

    // message.tsx offsets its node dot by these, so a change here has to change both.
    expect(styles.heading1.marginTop).toBe(darkTheme.spacing[3]);
    expect(styles.heading2.marginTop).toBe(darkTheme.spacing[3]);
    expect(styles.heading3.marginTop).toBe(darkTheme.spacing[1]);
    expect(styles.heading4.marginTop).toBe(darkTheme.spacing[1]);
    expect(styles.heading5).not.toHaveProperty("marginTop");
    expect(styles.heading6).not.toHaveProperty("marginTop");
  });
});
