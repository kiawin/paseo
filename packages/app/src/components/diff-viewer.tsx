import React from "react";
import { useTranslation } from "react-i18next";
import { View, Text, ScrollView as RNScrollView } from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import type { DiffLine } from "@/utils/tool-call-parsers";
import { buildChatSplitDiffRows, type ChatSplitDiffRow } from "@/utils/chat-split-diff";
import { diffLinePrefix } from "@/utils/diff-highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { getCodeInsets } from "./code-insets";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { isWeb } from "@/constants/platform";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

interface DiffViewerProps {
  diffLines: DiffLine[];
  maxHeight?: number;
  emptyLabel?: string;
  fillAvailableHeight?: boolean;
  /** Render removals and their replacements as two aligned columns. Needs width; see the caller. */
  split?: boolean;
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const lineContainerStyle = React.useMemo(
    () => [
      styles.line,
      line.type === "header" && styles.headerLine,
      line.type === "add" && styles.addLine,
      line.type === "remove" && styles.removeLine,
      line.type === "context" && styles.contextLine,
    ],
    [line.type],
  );

  return (
    <View style={lineContainerStyle}>
      <DiffLineBody line={line} />
    </View>
  );
}

function DiffLineBody({ line }: { line: DiffLine }) {
  const plainLineTextStyle = React.useMemo(
    () => [
      styles.lineText,
      line.type === "header" && styles.headerText,
      line.type === "add" && styles.addText,
      line.type === "remove" && styles.removeText,
      line.type === "context" && styles.contextText,
    ],
    [line.type],
  );
  const prefixStyle = React.useMemo(
    () => [
      line.type === "add" && styles.addText,
      line.type === "remove" && styles.removeText,
      line.type === "context" && styles.contextText,
    ],
    [line.type],
  );

  if (line.tokens) {
    return (
      <Text style={styles.lineText}>
        <Text style={prefixStyle}>{diffLinePrefix(line)}</Text>
        <DiffTokens tokens={line.tokens} />
      </Text>
    );
  }

  if (line.segments) {
    return (
      <Text style={styles.lineText}>
        <Text style={line.type === "add" ? styles.addText : styles.removeText}>
          {line.content[0]}
        </Text>
        {line.segments.map((segment) => (
          <DiffSegment
            key={`${segment.changed ? "c" : "u"}:${segment.text}`}
            segment={segment}
            lineType={line.type}
          />
        ))}
      </Text>
    );
  }

  return <Text style={plainLineTextStyle}>{line.content}</Text>;
}

function SplitDiffCell({ line }: { line: DiffLine | null }) {
  const cellStyle = React.useMemo(
    () => [
      styles.splitCell,
      line === null && styles.absentCell,
      line?.type === "add" && styles.addLine,
      line?.type === "remove" && styles.removeLine,
      line?.type === "context" && styles.contextLine,
    ],
    [line],
  );

  return <View style={cellStyle}>{line ? <DiffLineBody line={line} /> : null}</View>;
}

function SplitDiffRowView({ row }: { row: ChatSplitDiffRow }) {
  if (row.kind === "header") {
    return (
      <View style={[styles.line, styles.headerLine]}>
        <DiffLineBody line={row.line} />
      </View>
    );
  }

  return (
    <View style={styles.splitRow}>
      <SplitDiffCell line={row.left} />
      <SplitDiffCell line={row.right} />
    </View>
  );
}

function DiffTokens({ tokens }: { tokens: NonNullable<DiffLine["tokens"]> }) {
  const keyed = React.useMemo(
    () => tokens.map((token, index) => ({ key: `${index}-${token.text}`, token })),
    [tokens],
  );
  return (
    <>
      {keyed.map(({ key, token }) => (
        <Text key={key} style={token.style ? syntaxTokenStyleFor(token.style) : undefined}>
          {token.text}
        </Text>
      ))}
    </>
  );
}

function DiffSegment({
  segment,
  lineType,
}: {
  segment: NonNullable<DiffLine["segments"]>[number];
  lineType: DiffLine["type"];
}) {
  const segmentStyle = React.useMemo(
    () => [
      lineType === "add" ? styles.addText : styles.removeText,
      segment.changed && (lineType === "add" ? styles.addHighlight : styles.removeHighlight),
    ],
    [lineType, segment.changed],
  );
  return <Text style={segmentStyle}>{segment.text}</Text>;
}

export function DiffViewer({
  diffLines,
  maxHeight,
  emptyLabel,
  fillAvailableHeight = false,
  split = false,
}: DiffViewerProps) {
  const { t } = useTranslation();
  const [scrollViewWidth, setScrollViewWidth] = React.useState(0);
  const resolvedEmptyLabel = emptyLabel ?? t("diffViewer.empty");
  const handleInnerLayout = React.useCallback(
    (e: { nativeEvent: { layout: { width: number } } }) =>
      setScrollViewWidth(e.nativeEvent.layout.width),
    [],
  );

  const outerScrollStyle = React.useMemo(
    () => [
      styles.verticalScroll,
      maxHeight !== undefined && inlineUnistylesStyle({ maxHeight }),
      fillAvailableHeight && styles.fillHeight,
    ],
    [maxHeight, fillAvailableHeight],
  );
  const linesContainerStyle = React.useMemo(
    () => [
      styles.linesContainer,
      scrollViewWidth > 0 && inlineUnistylesStyle({ minWidth: scrollViewWidth }),
    ],
    [scrollViewWidth],
  );
  const keyedDiffLines = React.useMemo(
    () => diffLines.map((line, index) => ({ key: `${index}-${line.type}-${line.content}`, line })),
    [diffLines],
  );
  const keyedSplitRows = React.useMemo(
    () =>
      split
        ? buildChatSplitDiffRows(diffLines).map((row, index) => ({
            key:
              row.kind === "header"
                ? `${index}-header-${row.line.content}`
                : `${index}-pair-${row.left?.content ?? ""}-${row.right?.content ?? ""}`,
            row,
          }))
        : [],
    [split, diffLines],
  );
  const webVerticalContentStyle = React.useMemo(
    () => [styles.verticalContent, fillAvailableHeight && styles.fillHeight],
    [fillAvailableHeight],
  );

  if (!diffLines.length) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyText}>{resolvedEmptyLabel}</Text>
      </View>
    );
  }

  const lines = (
    <View style={linesContainerStyle} dataSet={CODE_SURFACE_DATASET} testID="diff-viewer-lines">
      {split
        ? keyedSplitRows.map(({ key, row }) => <SplitDiffRowView key={key} row={row} />)
        : keyedDiffLines.map(({ key, line }) => <DiffLineRow key={key} line={line} />)}
    </View>
  );

  const horizontalScroll = (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      contentContainerStyle={styles.horizontalContent}
      onLayout={handleInnerLayout}
    >
      {lines}
    </ScrollView>
  );

  const content = (
    <ScrollView
      style={outerScrollStyle}
      contentContainerStyle={webVerticalContentStyle}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      {horizontalScroll}
    </ScrollView>
  );

  return content;
}

const styles = StyleSheet.create((theme) => {
  const insets = getCodeInsets(theme);

  return {
    verticalScroll: {},
    fillHeight: {
      flex: 1,
      minHeight: 0,
    },
    verticalContent: {
      flexGrow: 1,
      paddingBottom: insets.extraBottom,
    },
    horizontalContent: {
      flexDirection: "column" as const,
      paddingRight: insets.extraRight,
    },
    linesContainer: {
      alignSelf: "flex-start",
      padding: insets.padding,
    },
    line: {
      minWidth: "100%",
      paddingHorizontal: 0,
      paddingVertical: theme.spacing[1],
    },
    lineText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      ...(isWeb
        ? {
            whiteSpace: "pre",
            overflowWrap: "normal",
          }
        : null),
    },
    headerLine: {
      backgroundColor: theme.colors.surface1,
    },
    headerText: {
      color: theme.colors.foregroundMuted,
    },
    addLine: {
      backgroundColor: "rgba(46, 160, 67, 0.15)",
    },
    addText: {
      color: theme.colors.foreground,
    },
    removeLine: {
      backgroundColor: "rgba(248, 81, 73, 0.1)",
    },
    removeText: {
      color: theme.colors.foreground,
    },
    addHighlight: {
      backgroundColor: "rgba(46, 160, 67, 0.4)",
    },
    removeHighlight: {
      backgroundColor: "rgba(248, 81, 73, 0.35)",
    },
    contextLine: {
      backgroundColor: theme.colors.surface1,
    },
    splitRow: {
      flexDirection: "row" as const,
      minWidth: "100%",
    },
    splitCell: {
      flex: 1,
      flexBasis: 0,
      minWidth: 0,
      paddingVertical: theme.spacing[1],
      paddingHorizontal: theme.spacing[1],
      borderRightWidth: 1,
      borderRightColor: theme.colors.border,
      // Diff text is whiteSpace: "pre", so a long line would paint over the other column
      // instead of stopping at the divider.
      overflow: "hidden" as const,
    },
    // No content on this side of the pair. Web draws the reference's diagonal hatch; other
    // platforms get a flat muted fill, which reads the same at a glance.
    absentCell: {
      backgroundColor: theme.colors.surface2,
      ...(isWeb
        ? {
            backgroundImage:
              "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(127,127,127,0.18) 4px, rgba(127,127,127,0.18) 8px)",
          }
        : null),
    },
    contextText: {
      color: theme.colors.foregroundMuted,
    },
    emptyState: {
      padding: theme.spacing[4],
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    emptyText: {
      fontSize: theme.fontSize.base,
      color: theme.colors.foregroundMuted,
    },
  };
});
