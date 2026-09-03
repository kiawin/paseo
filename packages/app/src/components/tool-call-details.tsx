import React, { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  View,
  Text,
  ScrollView as RNScrollView,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { Check, Copy } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import {
  buildPaseoToolDetailSections,
  type PaseoToolDetailSection,
} from "@getpaseo/protocol/paseo-tool-call-detail";
import { buildLineDiff, parseUnifiedDiff, type DiffLine } from "@/utils/tool-call-parsers";
import { highlightDiffLines } from "@/utils/diff-highlight";
import { hasMeaningfulToolCallDetail } from "@/utils/tool-call-detail-state";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { extensionFromPath, highlightToKeyedLines } from "@/utils/highlight-cache";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import {
  buildShellStreams,
  takeLines,
  type ShellStream,
  type ShellStreams as ShellStreamsModel,
} from "./shell-streams";
import { diffPreviewIsClamped, selectDiffPreviewLines } from "@/utils/diff-preview";
import { HighlightedLines } from "./highlighted-content";
import { DiffViewer } from "./diff-viewer";
import { getCodeInsets } from "./code-insets";
import { isWeb } from "@/constants/platform";
import { openExternalUrl } from "@/utils/open-external-url";
import { externalLinkHost } from "@/utils/external-link-host";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

// ---- Content Component ----

interface ToolCallDetailsContentProps {
  toolName?: string;
  detail?: ToolCallDetail;
  errorText?: string;
  maxHeight?: number;
  fillAvailableHeight?: boolean;
  showLoadingSkeleton?: boolean;
  /**
   * Clamp the card to this many lines of content. A pixel height slices whatever line it lands
   * in, leaving a half-rendered row; truncating the text keeps the card a whole number of lines.
   */
  previewLines?: number;
}

interface DetailStyles {
  sectionFillStyle: StyleProp<ViewStyle>;
  codeBlockFillStyle: StyleProp<ViewStyle>;
  codeVerticalScrollStyle: StyleProp<ViewStyle>;
  scrollAreaFillStyle: StyleProp<ViewStyle>;
  scrollAreaStyle: StyleProp<ViewStyle>;
  jsonScrollCombined: StyleProp<ViewStyle>;
  jsonScrollErrorCombined: StyleProp<ViewStyle>;
  fullBleedContainerStyle: StyleProp<ViewStyle>;
  loadingContainerStyle: StyleProp<ViewStyle>;
  resolvedMaxHeight: number | undefined;
  shouldFill: boolean;
  isFullBleed: boolean;
}

function resolveIsFullBleed(detail: ToolCallDetail | undefined): boolean {
  return detail?.type === "edit" || detail?.type === "shell" || detail?.type === "write";
}

function resolveShouldFill(
  detail: ToolCallDetail | undefined,
  fillAvailableHeight: boolean,
): boolean {
  if (!fillAvailableHeight) return false;
  const t = detail?.type;
  return t === "shell" || t === "edit" || t === "write" || t === "read" || t === "sub_agent";
}

function useDetailStyles(
  detail: ToolCallDetail | undefined,
  resolvedMaxHeight: number | undefined,
  fillAvailableHeight: boolean,
): DetailStyles {
  const isFullBleed = resolveIsFullBleed(detail);
  const shouldFill = resolveShouldFill(detail, fillAvailableHeight);
  const codeBlockStyle = isFullBleed ? styles.fullBleedBlock : styles.diffContainer;

  const sectionFillStyle = useMemo(
    () => [styles.section, shouldFill && styles.fillHeight],
    [shouldFill],
  );
  const codeBlockFillStyle = useMemo(
    () => [codeBlockStyle, shouldFill && styles.fillHeight],
    [codeBlockStyle, shouldFill],
  );
  const codeVerticalScrollStyle = useMemo(
    () => [
      styles.codeVerticalScroll,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
      shouldFill && styles.fillHeight,
    ],
    [resolvedMaxHeight, shouldFill],
  );
  const scrollAreaFillStyle = useMemo(
    () => [
      styles.scrollArea,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
      shouldFill && styles.fillHeight,
    ],
    [resolvedMaxHeight, shouldFill],
  );
  const scrollAreaStyle = useMemo(
    () => [
      styles.scrollArea,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
    ],
    [resolvedMaxHeight],
  );
  const jsonScrollCombined = styles.jsonScroll;
  const jsonScrollErrorCombined = [styles.jsonScroll, styles.jsonScrollError];
  const fullBleedContainerStyle = useMemo(
    () => [
      isFullBleed ? styles.fullBleedContainer : styles.paddedContainer,
      shouldFill && styles.fillHeight,
    ],
    [isFullBleed, shouldFill],
  );
  const loadingContainerStyle = useMemo(
    () => [styles.loadingContainer, fillAvailableHeight && styles.fillHeight],
    [fillAvailableHeight],
  );

  return {
    sectionFillStyle,
    codeBlockFillStyle,
    codeVerticalScrollStyle,
    scrollAreaFillStyle,
    scrollAreaStyle,
    jsonScrollCombined,
    jsonScrollErrorCombined,
    fullBleedContainerStyle,
    loadingContainerStyle,
    resolvedMaxHeight,
    shouldFill,
    isFullBleed,
  };
}

function useDiffLines(detail: ToolCallDetail | undefined): DiffLine[] | undefined {
  return useMemo(() => {
    if (!detail || detail.type !== "edit") return undefined;
    const diffLines = detail.unifiedDiff
      ? parseUnifiedDiff(detail.unifiedDiff)
      : buildLineDiff(detail.oldString ?? "", detail.newString ?? "");
    return highlightDiffLines(diffLines, detail.filePath);
  }, [detail]);
}

/** Sized to the gutter's mono line rather than the app's icon scale, which is taller. */
const SHELL_COPY_ICON_SIZE = 12;

interface ShellDetailProps {
  command: string;
  output: string | null | undefined;
  ds: DetailStyles;
  previewLines?: number;
}

function ShellDetailSection({ command, output, ds, previewLines }: ShellDetailProps) {
  const isCompact = useIsCompactFormFactor();
  const streams = useMemo(
    () => buildShellStreams(command, output, previewLines),
    [command, output, previewLines],
  );
  // A preview on a phone is a teaser for the sheet behind it, so it clips and ellipsises rather
  // than handing the reader a sideways scroller to fight inside the transcript list.
  const isCompactPreview = isCompact && previewLines !== undefined;
  const body = (
    <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
      <ShellStreamsView streams={streams} isCompact={isCompact} clip={isCompactPreview} />
    </View>
  );
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
          scrollEnabled={!isCompactPreview}
        >
          {isCompactPreview ? (
            <View style={styles.codeHorizontalClip}>{body}</View>
          ) : (
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator
              contentContainerStyle={styles.codeHorizontalContent}
            >
              {body}
            </ScrollView>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * Copies one stream whole. It lives in the label gutter because that column is what names the
 * stream — the card's own right edge belongs to whatever line is longest, and scrolls with it.
 */
function ShellStreamCopyButton({
  text,
  accessibilityLabel,
  visible,
}: {
  text: string;
  accessibilityLabel: string;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const getContent = useCallback(() => text, [text]);
  const { copied, copy } = useCopyFeedback({ getContent });
  // The card toggles on press, so copying out of it must not also close it.
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation?.();
      void copy();
    },
    [copy],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={[styles.shellStreamCopy, visible ? styles.copyVisible : styles.copyHidden]}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={copied ? t("message.actions.copied") : accessibilityLabel}
      testID="tool-call-shell-copy"
    >
      {({ hovered }) => {
        const color = hovered ? styles.copyIconHovered.color : styles.copyIcon.color;
        return copied ? (
          <Check size={SHELL_COPY_ICON_SIZE} color={color} />
        ) : (
          <Copy size={SHELL_COPY_ICON_SIZE} color={color} />
        );
      }}
    </Pressable>
  );
}

function ShellStreamRow({
  label,
  stream,
  copyLabel,
}: {
  label: string;
  stream: ShellStream;
  copyLabel: string;
}) {
  // Hover tracking sits on a plain View wrapping the button, per docs/hover.md: a Pressable that
  // owns hover would hand it to the button the moment the cursor arrived, and flicker.
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  return (
    <View
      style={styles.shellStreamRow}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <View style={styles.shellStreamGutter}>
        <Text style={styles.shellStreamLabel}>{label}</Text>
        <ShellStreamCopyButton
          text={stream.full}
          accessibilityLabel={copyLabel}
          visible={isHovered || isNative}
        />
      </View>
      <Text selectable style={styles.scrollText}>
        {stream.shown}
      </Text>
    </View>
  );
}

/**
 * One `Text` per line, because `numberOfLines` truncates a block as a whole — a single Text
 * holding newlines would drop whole trailing lines instead of ellipsising each one.
 */
function ClippedLines({ text, prompt }: { text: string; prompt?: boolean }) {
  return (
    <>
      {text.split("\n").map((line, index) => (
        // Lines have no identity of their own here, and the list is re-clamped on every render.
        // eslint-disable-next-line react/no-array-index-key
        <Text key={index} numberOfLines={1} ellipsizeMode="tail" style={styles.scrollText}>
          {prompt && index === 0 ? <Text style={styles.shellPrompt}>$ </Text> : null}
          {line}
        </Text>
      ))}
    </>
  );
}

function ShellStreamsView({
  streams,
  isCompact,
  clip = false,
}: {
  streams: ShellStreamsModel;
  isCompact: boolean;
  clip?: boolean;
}) {
  const { t } = useTranslation();
  const { command, output } = streams;

  if (isCompact) {
    if (clip) {
      return (
        <>
          <ClippedLines text={command.shown} prompt />
          {output === null ? null : <ClippedLines text={output.shown} />}
        </>
      );
    }
    // The gutter costs width a phone does not have, so compact goes back to the shell prompt to
    // tell command from output — and with no gutter there is nowhere to hang a copy button.
    return (
      <Text selectable style={styles.scrollText}>
        <Text style={styles.shellPrompt}>$ </Text>
        {command.shown}
        {output === null ? "" : `\n\n${output.shown}`}
      </Text>
    );
  }

  return (
    <>
      <ShellStreamRow
        label={t("toolCallDetails.inLabel")}
        stream={command}
        copyLabel={t("toolCallDetails.copyCommand")}
      />
      {output === null ? null : (
        <ShellStreamRow
          label={t("toolCallDetails.outLabel")}
          stream={output}
          copyLabel={t("toolCallDetails.copyOutput")}
        />
      )}
    </>
  );
}

interface WorktreeSetupDetailProps {
  log: string;
  branchName: string;
  worktreePath: string;
  ds: DetailStyles;
}

function WorktreeSetupDetailSection({
  log,
  branchName,
  worktreePath,
  ds,
}: WorktreeSetupDetailProps) {
  const setupLog = log.replace(/^\n+/, "");
  const hasLog = setupLog.length > 0;
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              <Text selectable style={styles.scrollText}>
                {hasLog ? setupLog : `Preparing worktree ${branchName} at ${worktreePath}`}
              </Text>
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

function resolveSubAgentFallbackHeader(
  subAgentType: string | null | undefined,
  description: string | null | undefined,
  fallbackText: string,
): string {
  if (subAgentType && description) {
    return `${subAgentType}: ${description}`;
  }
  return subAgentType ?? description ?? fallbackText;
}

interface SubAgentDetailProps {
  log: string;
  childSessionId: string | null | undefined;
  subAgentType: string | null | undefined;
  description: string | null | undefined;
  ds: DetailStyles;
}

interface SubAgentActivityRow {
  index: number;
  toolName: string;
  summary?: string;
}

interface ParsedSubAgentLog {
  actions: SubAgentActivityRow[];
  remainingLog: string;
}

function parseBracketedSubAgentLine(line: string, index: number): SubAgentActivityRow | null {
  const match = line.match(/^\[([^\]]+)\](?:\s+(.*))?$/);
  if (!match) {
    return null;
  }
  const toolName = match[1]?.trim();
  if (!toolName) {
    return null;
  }
  const summary = match[2]?.trim();
  return {
    index,
    toolName,
    ...(summary ? { summary } : {}),
  };
}

function parseSubAgentLog(log: string): ParsedSubAgentLog {
  const actions: SubAgentActivityRow[] = [];
  const remainingLines: string[] = [];
  for (const line of log.replace(/^\n+/, "").split("\n")) {
    const normalizedLine = line.trim();
    if (!normalizedLine) {
      continue;
    }
    const parsedAction = parseBracketedSubAgentLine(normalizedLine, actions.length + 1);
    if (parsedAction) {
      actions.push(parsedAction);
    } else {
      remainingLines.push(line);
    }
  }
  return {
    actions,
    remainingLog: remainingLines.join("\n").replace(/^\n+/, ""),
  };
}

function SubAgentActionRow({ action }: { action: SubAgentActivityRow }) {
  return (
    <View style={styles.subAgentActionRow}>
      <Text selectable style={styles.subAgentActionTool}>
        {formatSubAgentToolName(action.toolName)}
      </Text>
      {action.summary ? (
        <Text selectable style={styles.subAgentActionSummary}>
          {action.summary}
        </Text>
      ) : null}
    </View>
  );
}

function formatSubAgentToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) {
    return toolName;
  }
  return trimmed
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function SubAgentLogText({
  activityLog,
  fallbackHeader,
  hasActions,
}: {
  activityLog: string;
  fallbackHeader: string;
  hasActions: boolean;
}) {
  if (activityLog.length > 0) {
    return (
      <Text selectable style={styles.scrollText}>
        {activityLog}
      </Text>
    );
  }
  if (!hasActions) {
    return (
      <Text selectable style={styles.scrollText}>
        {fallbackHeader}
      </Text>
    );
  }
  return null;
}

function SubAgentDetailSection({
  log,
  childSessionId,
  subAgentType,
  description,
  ds,
}: SubAgentDetailProps) {
  const { t } = useTranslation();
  const { actions, remainingLog } = useMemo(() => parseSubAgentLog(log), [log]);
  const fallbackHeader = resolveSubAgentFallbackHeader(
    subAgentType,
    description,
    t("toolCallDetails.subAgentActivity"),
  );
  const hasActions = actions.length > 0;
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              {childSessionId ? (
                <Text selectable style={styles.subAgentSessionText}>
                  session {childSessionId}
                </Text>
              ) : null}
              {hasActions ? (
                <View style={styles.subAgentActions}>
                  {actions.map((action) => (
                    <SubAgentActionRow key={action.index} action={action} />
                  ))}
                </View>
              ) : null}
              <SubAgentLogText
                activityLog={remainingLog}
                fallbackHeader={fallbackHeader}
                hasActions={hasActions}
              />
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

interface EditDetailProps {
  diffLines: DiffLine[] | undefined;
  ds: DetailStyles;
  previewLines?: number;
}

function EditDetailSection({ diffLines, ds, previewLines }: EditDetailProps) {
  // Two columns need width, so this follows the form factor rather than a user preference.
  const isCompact = useIsCompactFormFactor();

  return (
    <View style={ds.sectionFillStyle}>
      {diffLines ? (
        <View style={ds.codeBlockFillStyle}>
          <DiffViewer
            diffLines={diffLines}
            maxHeight={ds.resolvedMaxHeight}
            fillAvailableHeight={ds.shouldFill}
            split={!isCompact}
            clipHorizontally={isCompact && previewLines !== undefined}
          />
        </View>
      ) : null}
    </View>
  );
}

interface ScrollableContentProps {
  content: string;
  ds: DetailStyles;
  wrapInSectionFill?: boolean;
  // Drives syntax highlighting (extension only) and, with startLine, a gutter.
  filePath?: string | null;
  startLine?: number;
}

function ScrollableTextSection({
  content,
  ds,
  wrapInSectionFill = true,
  filePath,
  startLine,
}: ScrollableContentProps) {
  const keyedLines = useMemo(
    () => (filePath ? highlightToKeyedLines(content, extensionFromPath(filePath)) : null),
    [content, filePath],
  );
  const body = (
    <ScrollView
      style={ds.scrollAreaFillStyle}
      contentContainerStyle={styles.scrollContent}
      nestedScrollEnabled
      showsVerticalScrollIndicator={true}
    >
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={true}>
        {keyedLines ? (
          <HighlightedLines lines={keyedLines} startLine={startLine} />
        ) : (
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            {content}
          </Text>
        )}
      </ScrollView>
    </ScrollView>
  );
  if (!wrapInSectionFill) return body;
  return <View style={ds.sectionFillStyle}>{body}</View>;
}

interface FetchDetailProps {
  url: string;
  result: string | null | undefined;
  ds: DetailStyles;
}

function FetchDetailSection({ url, result, ds }: FetchDetailProps) {
  return (
    <View style={ds.sectionFillStyle}>
      <ScrollView
        style={ds.scrollAreaFillStyle}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            {result ? `${url}\n\n${result}` : url}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function ArtifactDetailSection({ url, title }: { url: string; title?: string }) {
  const { t } = useTranslation();
  const host = useMemo(() => externalLinkHost(url), [url]);
  // The card around this link toggles on press, so opening the link must not also close the card.
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation?.();
      void openExternalUrl(url);
    },
    [url],
  );

  return (
    <View style={styles.section}>
      {title ? (
        <Text selectable style={styles.plainText}>
          {title}
        </Text>
      ) : null}
      {/* The destination is named before the tap. openExternalUrl owns the scheme allowlist. */}
      <Pressable onPress={handlePress} testID="tool-call-artifact-link">
        <Text style={styles.artifactLink} numberOfLines={1}>
          {host ? t("toolCallDetails.artifactOpenOn", { host }) : url}
        </Text>
      </Pressable>
    </View>
  );
}

function ScrollablePlainTextSection({ text, ds }: { text: string; ds: DetailStyles }) {
  return (
    <View style={styles.section}>
      <ScrollView
        style={ds.scrollAreaStyle}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <Text selectable style={styles.plainText}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

interface SearchDetail {
  query?: string;
  content?: string;
  filePaths?: string[];
  webResults?: { title: string; url: string }[];
  annotations?: string[];
}

function buildSearchSections(detail: SearchDetail, ds: DetailStyles): ReactNode[] {
  const out: ReactNode[] = [];
  if (detail.content) {
    out.push(
      <View key="search-content" style={styles.section}>
        <ScrollView
          style={ds.scrollAreaStyle}
          contentContainerStyle={styles.scrollContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
            <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
              {detail.content}
            </Text>
          </ScrollView>
        </ScrollView>
      </View>,
    );
  }
  if (detail.filePaths && detail.filePaths.length > 0) {
    out.push(
      <View key="search-files" style={styles.section}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          {detail.filePaths.join("\n")}
        </Text>
      </View>,
    );
  }
  if (detail.webResults && detail.webResults.length > 0) {
    out.push(
      <View key="search-web-results" style={styles.section}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          {detail.webResults.map((entry) => `${entry.title}\n${entry.url}`).join("\n\n")}
        </Text>
      </View>,
    );
  }
  if (detail.annotations && detail.annotations.length > 0) {
    out.push(
      <View key="search-annotations" style={styles.section}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          {detail.annotations.join("\n\n")}
        </Text>
      </View>,
    );
  }
  return out;
}

function serializeUnknownValue(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface UnknownDetail {
  input: unknown;
  output: unknown;
}

function buildUnknownSections(detail: UnknownDetail, ds: DetailStyles, t: TFunction): ReactNode[] {
  const plainInputText =
    typeof detail.input === "string" && detail.output === null ? detail.input : null;

  if (plainInputText !== null) {
    return [<ScrollablePlainTextSection key="unknown-plain-text" text={plainInputText} ds={ds} />];
  }

  const sectionsFromTopLevel = [
    { title: t("toolCallDetails.input"), value: detail.input },
    { title: t("toolCallDetails.output"), value: detail.output },
  ].filter((entry) =>
    hasMeaningfulToolCallDetail({
      type: "unknown",
      input: entry.value ?? null,
      output: null,
    }),
  );

  const out: ReactNode[] = [];
  for (const section of sectionsFromTopLevel) {
    const value = serializeUnknownValue(section.value);
    if (!value.length) {
      continue;
    }
    out.push(
      <View key={`${section.title}-header`} style={styles.groupHeader}>
        <Text style={styles.groupHeaderText}>{section.title}</Text>
      </View>,
    );
    out.push(
      <View key={`${section.title}-value`} style={styles.section}>
        <ScrollView
          horizontal
          nestedScrollEnabled
          style={ds.jsonScrollCombined}
          contentContainerStyle={styles.jsonContent}
          showsHorizontalScrollIndicator={true}
        >
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            {value}
          </Text>
        </ScrollView>
      </View>,
    );
  }
  return out;
}

function PaseoDetailSection({ section }: { section: PaseoToolDetailSection }) {
  return (
    <View style={styles.paseoSection}>
      <Text style={styles.paseoSectionTitle}>{section.title}</Text>
      {section.kind === "prose" ? (
        <Text selectable style={styles.paseoProse}>
          {section.text}
        </Text>
      ) : (
        <View style={styles.paseoFields}>
          {section.fields.map((field) => (
            <View key={field.label} style={styles.paseoFieldRow}>
              <Text style={styles.paseoFieldLabel}>{field.label}</Text>
              <Text selectable style={styles.paseoFieldValue}>
                {field.value}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function buildPaseoUnknownSections(
  toolName: string | undefined,
  detail: UnknownDetail,
): ReactNode[] | null {
  if (!toolName) return null;
  const sections = buildPaseoToolDetailSections(toolName, detail.input, detail.output);
  if (!sections) return null;
  return sections.map((section) => <PaseoDetailSection key={section.title} section={section} />);
}

function exceedsPreview(
  detail: ToolCallDetail | undefined,
  diffLines: DiffLine[] | undefined,
  previewLines: number | undefined,
): boolean {
  if (detail === undefined || previewLines === undefined) {
    return false;
  }
  if (detail.type === "shell") {
    return (
      takeLines(detail.command.replace(/\n+$/, ""), previewLines).truncated ||
      takeLines((detail.output ?? "").replace(/^\n+/, ""), previewLines).truncated
    );
  }
  return diffLines !== undefined && diffPreviewIsClamped(diffLines, previewLines);
}

function buildDetailSections(
  toolName: string | undefined,
  detail: ToolCallDetail | undefined,
  diffLines: DiffLine[] | undefined,
  ds: DetailStyles,
  t: TFunction,
  previewLines?: number,
): ReactNode[] {
  if (!detail) return [];
  if (detail.type === "shell") {
    return [
      <ShellDetailSection
        key="shell"
        command={detail.command}
        output={detail.output}
        ds={ds}
        previewLines={previewLines}
      />,
    ];
  }
  if (detail.type === "worktree_setup") {
    return [
      <WorktreeSetupDetailSection
        key="worktree-setup"
        log={detail.log}
        branchName={detail.branchName}
        worktreePath={detail.worktreePath}
        ds={ds}
      />,
    ];
  }
  if (detail.type === "sub_agent") {
    return [
      <SubAgentDetailSection
        key="sub-agent"
        log={detail.log}
        childSessionId={detail.childSessionId}
        subAgentType={detail.subAgentType}
        description={detail.description}
        ds={ds}
      />,
    ];
  }
  if (detail.type === "edit") {
    return [
      <EditDetailSection key="edit" diffLines={diffLines} ds={ds} previewLines={previewLines} />,
    ];
  }
  if (detail.type === "write") {
    return [
      <View key="write" style={ds.sectionFillStyle}>
        {detail.content ? (
          <ScrollableTextSection
            content={detail.content}
            ds={ds}
            wrapInSectionFill={false}
            filePath={detail.filePath}
          />
        ) : null}
      </View>,
    ];
  }
  if (detail.type === "read") {
    if (!detail.content) return [];
    return [
      <ScrollableTextSection
        key="read"
        content={detail.content}
        ds={ds}
        filePath={detail.filePath}
        startLine={detail.offset ?? 1}
      />,
    ];
  }
  if (detail.type === "search") {
    return buildSearchSections(detail, ds);
  }
  if (detail.type === "fetch") {
    return [<FetchDetailSection key="fetch" url={detail.url} result={detail.result} ds={ds} />];
  }
  if (detail.type === "artifact") {
    return [<ArtifactDetailSection key="artifact" url={detail.url} title={detail.title} />];
  }
  if (detail.type === "plain_text") {
    if (!detail.text) return [];
    return [<ScrollablePlainTextSection key="plain-text" text={detail.text} ds={ds} />];
  }
  if (detail.type === "unknown") {
    return buildPaseoUnknownSections(toolName, detail) ?? buildUnknownSections(detail, ds, t);
  }
  return [];
}

function ErrorSection({ errorText, ds }: { errorText: string; ds: DetailStyles }) {
  const { t } = useTranslation();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, styles.errorText]}>{t("toolCallDetails.error")}</Text>
      <ScrollView
        horizontal
        nestedScrollEnabled
        style={ds.jsonScrollErrorCombined}
        contentContainerStyle={styles.jsonContent}
        showsHorizontalScrollIndicator={true}
      >
        <Text
          selectable
          style={[styles.scrollText, styles.errorText]}
          dataSet={CODE_SURFACE_DATASET}
        >
          {errorText}
        </Text>
      </ScrollView>
    </View>
  );
}

function LoadingSkeleton({ containerStyle }: { containerStyle: StyleProp<ViewStyle> }) {
  return (
    <View style={containerStyle}>
      <View style={styles.loadingLineWide} />
      <View style={styles.loadingLineMedium} />
      <View style={styles.loadingLineShort} />
    </View>
  );
}

export function ToolCallDetailsContent({
  toolName,
  detail,
  errorText,
  maxHeight,
  fillAvailableHeight = false,
  showLoadingSkeleton = false,
  previewLines,
}: ToolCallDetailsContentProps) {
  const { t } = useTranslation();
  const isCompactLayout = useIsCompactFormFactor();
  const resolvedMaxHeight = fillAvailableHeight ? undefined : (maxHeight ?? 300);
  const ds = useDetailStyles(detail, resolvedMaxHeight, fillAvailableHeight);
  const allDiffLines = useDiffLines(detail);
  const diffLines = useMemo(() => {
    if (previewLines === undefined || allDiffLines === undefined) return allDiffLines;
    return selectDiffPreviewLines(allDiffLines, previewLines);
  }, [allDiffLines, previewLines]);

  const sections: ReactNode[] = buildDetailSections(
    toolName,
    detail,
    diffLines,
    ds,
    t,
    previewLines,
  );
  // Compact routes the whole row to the sheet on tap, so the pill would be a second affordance
  // for a gesture the row already has.
  const showExpandPill = !isCompactLayout && exceedsPreview(detail, allDiffLines, previewLines);

  if (errorText) {
    sections.push(<ErrorSection key="error" errorText={errorText} ds={ds} />);
  }

  if (sections.length === 0) {
    if (showLoadingSkeleton) {
      return <LoadingSkeleton containerStyle={ds.loadingContainerStyle} />;
    }
    return <Text style={styles.emptyStateText}>{t("toolCallDetails.empty")}</Text>;
  }

  return (
    <View style={ds.fullBleedContainerStyle}>
      {sections}
      {showExpandPill ? (
        <View style={styles.expandPill} pointerEvents="none">
          <Text style={styles.expandPillText}>{t("toolCallDetails.clickToExpand")}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ---- Styles ----

const styles = StyleSheet.create((theme) => {
  const insets = getCodeInsets(theme);

  return {
    paddedContainer: {
      gap: theme.spacing[4],
      padding: 0,
    },
    fullBleedContainer: {
      gap: theme.spacing[2],
      padding: 0,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
    },
    groupHeaderText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.normal,
    },
    paseoSection: {
      gap: theme.spacing[3],
      paddingHorizontal: theme.spacing[4],
      paddingVertical: theme.spacing[4],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
    },
    paseoSectionTitle: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.medium,
    },
    paseoProse: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      lineHeight: Math.round(theme.fontSize.content * 1.5),
      overflowWrap: "anywhere",
    },
    paseoFields: {
      gap: theme.spacing[3],
    },
    paseoFieldRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing[4],
    },
    paseoFieldLabel: {
      width: 120,
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
      lineHeight: Math.round(theme.fontSize.base * 1.5),
    },
    paseoFieldValue: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      lineHeight: Math.round(theme.fontSize.base * 1.5),
      overflowWrap: "anywhere",
    },
    section: {
      gap: theme.spacing[2],
    },
    fillHeight: {
      flex: 1,
      minHeight: 0,
    },
    artifactLink: {
      fontFamily: theme.fontFamily.ui,
      fontSize: theme.fontSize.base,
      color: theme.colors.primary,
      lineHeight: 22,
    },
    plainText: {
      fontFamily: theme.fontFamily.ui,
      fontSize: theme.fontSize.base,
      color: theme.colors.foreground,
      lineHeight: 22,
      overflowWrap: "anywhere",
    },
    sectionTitle: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.semibold,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    rangeText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    diffContainer: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      overflow: "hidden",
      backgroundColor: theme.colors.surface2,
    },
    fullBleedBlock: {
      borderWidth: 0,
      borderRadius: 0,
      overflow: "hidden",
      backgroundColor: theme.colors.surface1,
    },
    codeVerticalScroll: {},
    codeVerticalContent: {
      flexGrow: 1,
      paddingBottom: insets.extraBottom,
    },
    codeHorizontalClip: {
      overflow: "hidden" as const,
    },
    codeHorizontalContent: {
      paddingRight: insets.extraRight,
    },
    codeLine: {
      minWidth: "100%",
      paddingHorizontal: insets.padding,
      paddingVertical: insets.padding,
    },
    scrollArea: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      backgroundColor: theme.colors.surface2,
    },
    scrollContent: {
      padding: insets.padding,
    },
    scrollText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      lineHeight: 18,
      ...(isWeb
        ? {
            whiteSpace: "pre",
            overflowWrap: "normal",
          }
        : null),
    },
    shellPrompt: {
      color: theme.colors.foregroundMuted,
    },
    shellStreamRow: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: theme.spacing[3],
    },
    // Fixed width so IN and OUT content starts on the same column.
    shellStreamLabel: {
      width: 28,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foregroundMuted,
    },
    // The button is always mounted so the gutter is one width, hovered or not — a column that
    // widened under the cursor would shift the code beside it on every hover.
    shellStreamGutter: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: theme.spacing[1],
    },
    shellStreamCopy: {
      width: SHELL_COPY_ICON_SIZE,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    // Hidden by opacity rather than unmounted: mounting on hover would reflow the gutter under
    // the cursor. `pointerEvents` rides on the style so the deprecated prop form stays out.
    copyVisible: {
      opacity: 1,
      pointerEvents: "auto" as const,
    },
    copyHidden: {
      opacity: 0,
      pointerEvents: "none" as const,
    },
    copyIcon: {
      color: theme.colors.foregroundMuted,
    },
    copyIconHovered: {
      color: theme.colors.foreground,
    },
    // Sits over the bottom-right of a clamped card. Whole-line truncation is silent on its own,
    // so without this a clamped card and a complete one look identical.
    expandPill: {
      position: "absolute",
      right: theme.spacing[2],
      bottom: theme.spacing[2],
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[1],
      borderRadius: theme.borderRadius.sm,
      backgroundColor: theme.colors.surface3,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    expandPillText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    subAgentSessionText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foregroundMuted,
      lineHeight: 18,
      marginBottom: theme.spacing[2],
    },
    subAgentActions: {
      gap: theme.spacing[1],
      marginBottom: theme.spacing[2],
    },
    subAgentActionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    subAgentActionTool: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foregroundMuted,
      lineHeight: 18,
    },
    subAgentActionSummary: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      lineHeight: 18,
    },
    jsonScroll: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      backgroundColor: theme.colors.surface2,
    },
    jsonScrollError: {
      borderColor: theme.colors.destructive,
    },
    jsonContent: {
      padding: insets.padding,
    },
    errorText: {
      color: theme.colors.destructive,
    },
    emptyStateText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.base,
      fontStyle: "italic",
    },
    loadingContainer: {
      gap: theme.spacing[2],
      padding: theme.spacing[3],
    },
    loadingLineWide: {
      height: 12,
      width: "100%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
    loadingLineMedium: {
      height: 12,
      width: "72%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
    loadingLineShort: {
      height: 12,
      width: "48%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
  };
});
