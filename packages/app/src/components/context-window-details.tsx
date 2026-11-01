import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentContextUsage } from "@getpaseo/protocol/messages";
import { isWeb } from "@/constants/platform";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { AgentUsage } from "@/usage";
import { buildContextWindowBreakdown } from "./context-window-breakdown.utils";
import { formatContextPercentage, formatTokenCount } from "./context-window-meter.utils";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const chevronColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const CHEVRON_SLOT_WIDTH = 14;

interface ContextWindowDetailsProps {
  serverId: string;
  agentId: string;
  context: { percentage: number; usedTokens: number; maxTokens: number } | null;
  sessionCost: string | null;
  showTitle: boolean;
  refreshable: boolean;
}

/** Shared by the desktop hover card, native tooltip, and compact sheet. */
export function ContextWindowDetails({
  serverId,
  agentId,
  context,
  sessionCost,
  showTitle,
  refreshable,
}: ContextWindowDetailsProps) {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentContextUsage === true,
  );
  const query = useFetchQuery({
    queryKey: ["agent-context-usage", serverId, agentId],
    queryFn: async ({ signal }) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client || signal.aborted) return null;
      return client.getAgentContextUsage(agentId);
    },
    enabled: connected && supported,
    dataShape: "value",
    gcTime: 0,
    retry: false,
    staleTimeMs: 0,
  });
  const usage = connected && supported ? (query.data ?? null) : null;
  const breakdown = buildContextWindowBreakdown(usage);
  const displayContext =
    breakdown && usage?.totalTokens !== undefined && usage.rawMaxTokens !== undefined
      ? {
          percentage: usage.percentage ?? (usage.totalTokens / usage.rawMaxTokens) * 100,
          usedTokens: usage.totalTokens,
          maxTokens: usage.rawMaxTokens,
        }
      : context;

  return (
    <>
      <View style={styles.summary}>
        {showTitle ? <Text style={styles.title}>{t("contextWindow.title")}</Text> : null}
        {displayContext ? (
          <>
            <Text style={styles.text}>
              {t("contextWindow.used", { percentage: Math.round(displayContext.percentage) })}
            </Text>
            <Text style={styles.detail}>
              {t("contextWindow.tokens", {
                used: formatTokenCount(displayContext.usedTokens),
                max: formatTokenCount(displayContext.maxTokens),
              })}
            </Text>
          </>
        ) : (
          <Text style={styles.detail}>{t("contextWindow.noData")}</Text>
        )}
        {sessionCost ? (
          <Text style={styles.detail}>{t("contextWindow.sessionCost", { cost: sessionCost })}</Text>
        ) : null}
        {breakdown && usage ? <Breakdown usage={usage} breakdown={breakdown} /> : null}
      </View>
      <AgentUsage serverId={serverId} agentId={agentId} refreshable={refreshable} />
    </>
  );
}

function Breakdown({
  usage,
  breakdown,
}: {
  usage: AgentContextUsage;
  breakdown: NonNullable<ReturnType<typeof buildContextWindowBreakdown>>;
}) {
  const { t } = useTranslation();
  const groups = [
    {
      id: "skills",
      label: t("contextWindow.skills"),
      items: (usage.skills ?? []).flatMap((item) =>
        item.name && item.tokens !== undefined
          ? [{ key: `${item.source ?? ""}:${item.name}`, name: item.name, tokens: item.tokens }]
          : [],
      ),
    },
    {
      id: "mcp_tools",
      label: t("contextWindow.mcpTools"),
      items: (usage.mcpTools ?? []).flatMap((item) =>
        item.isLoaded === true && item.name && item.tokens !== undefined
          ? [{ key: `${item.serverName ?? ""}:${item.name}`, name: item.name, tokens: item.tokens }]
          : [],
      ),
    },
    {
      id: "mcp_tools_deferred",
      label: t("contextWindow.mcpTools"),
      items: (usage.mcpTools ?? []).flatMap((item) =>
        item.isLoaded === false && item.name && item.tokens !== undefined
          ? [{ key: `${item.serverName ?? ""}:${item.name}`, name: item.name, tokens: item.tokens }]
          : [],
      ),
    },
    {
      id: "mcp_tools_unknown",
      label: t("contextWindow.mcpTools"),
      items: (usage.mcpTools ?? []).flatMap((item) =>
        item.isLoaded === undefined && item.name && item.tokens !== undefined
          ? [{ key: `${item.serverName ?? ""}:${item.name}`, name: item.name, tokens: item.tokens }]
          : [],
      ),
    },
    {
      id: "memory_files",
      label: t("contextWindow.memoryFiles"),
      items: (usage.memoryFiles ?? []).flatMap((item) =>
        item.path && item.tokens !== undefined
          ? [{ key: `${item.type ?? ""}:${item.path}`, name: item.path, tokens: item.tokens }]
          : [],
      ),
    },
    {
      id: "agents",
      label: t("contextWindow.agents"),
      items: (usage.agents ?? []).flatMap((item) =>
        item.agentType && item.tokens !== undefined
          ? [
              {
                key: `${item.source ?? ""}:${item.agentType}`,
                name: item.agentType,
                tokens: item.tokens,
              },
            ]
          : [],
      ),
    },
  ];
  const categories = [...breakdown.rows, ...breakdown.deferred];
  return (
    <View style={styles.breakdown}>
      <View style={styles.bar}>
        {breakdown.rows
          .filter((row) => row.barPercentage > 0)
          .map((row) => (
            <View
              key={row.id ?? `${row.kind}:${row.name}`}
              style={[
                styles.segment,
                styles.categoryColor(row.colorIndex),
                { width: `${row.barPercentage}%` },
              ]}
            />
          ))}
      </View>
      {breakdown.rows.map((row) => (
        <CategoryRow
          key={row.id ?? `${row.kind}:${row.name}`}
          row={row}
          items={groups.find((group) => group.id === row.id)?.items ?? []}
        />
      ))}
      {breakdown.deferred.length ? (
        <View style={styles.deferred}>
          <Text style={styles.detail}>{t("contextWindow.notInWindow")}</Text>
          {breakdown.deferred.map((row) => (
            <CategoryRow
              key={row.id ?? `${row.kind}:${row.name}`}
              row={row}
              items={groups.find((group) => group.id === row.id)?.items ?? []}
            />
          ))}
        </View>
      ) : null}
      {groups
        .filter((group) => group.items.length > 0 && !categories.some((row) => row.id === group.id))
        .map((group) => (
          <DetailGroup key={group.id} {...group} />
        ))}
    </View>
  );
}

type BreakdownCategory =
  | NonNullable<ReturnType<typeof buildContextWindowBreakdown>>["rows"][number]
  | NonNullable<ReturnType<typeof buildContextWindowBreakdown>>["deferred"][number];
interface DetailItem {
  key: string;
  name: string;
  tokens: number;
}

function CategoryRow({ row, items }: { row: BreakdownCategory; items: DetailItem[] }) {
  const { i18n } = useTranslation();
  const content = (
    <>
      <View
        style={[
          styles.swatch,
          row.kind === "free" ? styles.freeSwatch : styles.categoryColor(row.colorIndex),
        ]}
      />
      <Text style={styles.rowName} numberOfLines={1}>
        {row.name}
      </Text>
      <Text style={[styles.detail, styles.tokens]}>{formatTokenCount(row.tokens)}</Text>
      <Text style={styles.percentage}>
        {"percentage" in row
          ? formatContextPercentage(row.percentage, i18n.resolvedLanguage)
          : null}
      </Text>
    </>
  );
  if (items.length)
    return (
      <DetailGroup label={row.name} items={items}>
        {content}
      </DetailGroup>
    );
  return (
    <View style={styles.row}>
      {content}
      <View style={styles.chevronSlot} />
    </View>
  );
}

function DetailGroup({
  label,
  items,
  children,
}: {
  label: string;
  items: DetailItem[];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      hovered && styles.groupHighlight,
      pressed && styles.groupHighlight,
    ],
    [],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const webExpandedProps = useMemo(() => (isWeb ? { "aria-expanded": expanded } : {}), [expanded]);
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  return (
    <View>
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        {...webExpandedProps}
        onPress={toggle}
        style={rowStyle}
        highlightStyle={styles.groupHighlight}
      >
        {children ?? <Text style={styles.groupName}>{label}</Text>}
        <View style={styles.chevronSlot}>
          <Chevron size={14} uniProps={chevronColor} />
        </View>
      </PressHighlight>
      {expanded ? (
        <ScrollView nestedScrollEnabled style={styles.items}>
          {items.map((item) => (
            <View style={styles.item} key={item.key}>
              <Text style={styles.itemName} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.detail}>
                {t("contextWindow.itemTokens", { tokens: formatTokenCount(item.tokens) })}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: { gap: theme.spacing[1.5], minWidth: 200 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  breakdown: { minWidth: 250, gap: theme.spacing[1.5], paddingTop: theme.spacing[2] },
  bar: {
    height: 8,
    flexDirection: "row",
    borderRadius: theme.borderRadius.full,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
  },
  segment: { height: "100%" },
  categoryColor: (index: number) => ({
    backgroundColor: [
      theme.colors.palette.blue[500],
      theme.colors.palette.purple[500],
      theme.colors.palette.green[500],
      theme.colors.palette.orange[500],
      theme.colors.palette.amber[500],
      theme.colors.palette.zinc[500],
    ][index % 6],
  }),
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], minHeight: 28 },
  swatch: { width: 8, height: 8, borderRadius: theme.borderRadius.full },
  freeSwatch: { backgroundColor: theme.colors.surface3 },
  rowName: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  // Every row ends in the same slot, so percentages line up whether or not the row expands.
  chevronSlot: { width: CHEVRON_SLOT_WIDTH, alignItems: "center", justifyContent: "center" },
  tokens: { width: 44, textAlign: "right" },
  percentage: {
    width: 40,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  deferred: { opacity: 0.65, gap: theme.spacing[1], paddingTop: theme.spacing[1] },
  groupHighlight: { backgroundColor: theme.colors.interactionHighlight },
  groupName: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  // Item tokens end under the percentage column rather than under the chevron.
  items: {
    maxHeight: 160,
    paddingLeft: theme.spacing[4],
    paddingRight: CHEVRON_SLOT_WIDTH + theme.spacing[2],
  },
  item: { flexDirection: "row", gap: theme.spacing[2], paddingVertical: theme.spacing[0.5] },
  itemName: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
