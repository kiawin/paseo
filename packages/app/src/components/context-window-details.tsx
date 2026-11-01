import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentContextUsage } from "@getpaseo/protocol/messages";
import type { AgentMetric } from "@getpaseo/protocol/agent-types";
import { AgentUsage } from "@/usage";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { formatTokenCount } from "./context-window-meter.utils";
import { buildContextWindowBreakdown } from "./context-window-breakdown.utils";
import { MetricsList } from "./metrics-list";
import { PressHighlight } from "@/components/ui/press-highlight";

interface ContextWindowDetailsProps {
  serverId: string;
  agentId: string;
  context: {
    percentage: number;
    usedTokens: number;
    maxTokens: number;
  } | null;
  sessionCost: string | null;
  /** What the provider reports about the session. A reported cost replaces `sessionCost`. */
  sessionMetrics: AgentMetric[];
  /** The hover card and tooltip title themselves; the sheet's header carries the title instead. */
  showTitle: boolean;
  /** Whether the usage cards have a Refresh button; without one they show their freshness. */
  refreshable: boolean;
}

/**
 * What the context window meter opens: how full the window is, what the provider reports about the
 * session, then the usage of the agent's account. The desktop hover card, the native wide tooltip, and the compact sheet all render it.
 */
export function ContextWindowDetails({
  serverId,
  agentId,
  context,
  sessionCost,
  sessionMetrics,
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
  const providerReportsCost = sessionMetrics.some(
    (metric) => metric.label.toLowerCase() === "cost",
  );
  return (
    <>
      <View style={styles.summary}>
        {showTitle ? <Text style={styles.title}>{t("contextWindow.title")}</Text> : null}
        {displayContext ? (
          <>
            <Text style={styles.text}>
              {t("contextWindow.used", { percentage: displayContext.percentage })}
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
        {sessionCost && !providerReportsCost ? (
          <Text style={styles.detail}>{t("contextWindow.sessionCost", { cost: sessionCost })}</Text>
        ) : null}
      </View>
      {breakdown && usage ? <ContextBreakdown usage={usage} breakdown={breakdown} /> : null}
      {sessionMetrics.length > 0 ? <MetricsList metrics={sessionMetrics} /> : null}
      <AgentUsage serverId={serverId} agentId={agentId} refreshable={refreshable} />
    </>
  );
}

function ContextBreakdown({
  usage,
  breakdown,
}: {
  usage: AgentContextUsage;
  breakdown: NonNullable<ReturnType<typeof buildContextWindowBreakdown>>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  const groups = [
    {
      id: "skills",
      items: (usage.skills ?? []).flatMap((item) =>
        item.name && item.tokens !== undefined ? [{ name: item.name, tokens: item.tokens }] : [],
      ),
    },
    {
      id: "mcp_tools",
      items: (usage.mcpTools ?? [])
        .filter((item) => item.isLoaded === true)
        .flatMap((item) =>
          item.name && item.tokens !== undefined ? [{ name: item.name, tokens: item.tokens }] : [],
        ),
    },
    {
      id: "mcp_tools_deferred",
      items: (usage.mcpTools ?? [])
        .filter((item) => item.isLoaded === false)
        .flatMap((item) =>
          item.name && item.tokens !== undefined ? [{ name: item.name, tokens: item.tokens }] : [],
        ),
    },
    {
      id: "memory_files",
      items: (usage.memoryFiles ?? []).flatMap((item) =>
        item.path && item.tokens !== undefined ? [{ name: item.path, tokens: item.tokens }] : [],
      ),
    },
    {
      id: "agents",
      items: (usage.agents ?? []).flatMap((item) =>
        item.agentType && item.tokens !== undefined
          ? [{ name: item.agentType, tokens: item.tokens }]
          : [],
      ),
    },
  ];
  return (
    <View style={styles.breakdown}>
      <View style={styles.bar}>
        {breakdown.rows
          .filter((row) => row.barPercentage > 0)
          .map((row) => (
            <View
              key={row.id ?? row.name}
              style={[styles.segment, { width: `${row.barPercentage}%` }]}
            />
          ))}
      </View>
      {breakdown.rows.map((row) => (
        <ContextCategory
          key={row.id ?? row.name}
          row={row}
          groups={groups}
          expanded={expanded}
          setExpanded={setExpanded}
        />
      ))}
      {breakdown.deferred.length > 0 ? (
        <View style={styles.deferred}>
          <Text style={styles.detail}>{t("contextWindow.notInWindow")}</Text>
          {breakdown.deferred.map((row) => (
            <ContextCategory
              key={row.id ?? row.name}
              row={row}
              groups={groups}
              expanded={expanded}
              setExpanded={setExpanded}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ContextCategory({
  row,
  groups,
  expanded,
  setExpanded,
}: {
  row: { id?: string; name: string; tokens: number; percentage?: number };
  groups: Array<{ id: string; items: Array<{ name: string; tokens: number }> }>;
  expanded: string | null;
  setExpanded: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const items = groups.find((group) => group.id === row.id)?.items ?? [];
  const isExpanded = expanded === row.id;
  const accessibilityState = useMemo(() => ({ expanded: isExpanded }), [isExpanded]);
  const handlePress = useCallback(
    () => setExpanded(isExpanded ? null : (row.id ?? null)),
    [isExpanded, row.id, setExpanded],
  );
  const content = (
    <>
      <Text style={styles.rowName} numberOfLines={1}>
        {row.name}
      </Text>
      <Text style={styles.detail}>{formatTokenCount(row.tokens)}</Text>
      {row.percentage !== undefined ? (
        <Text style={styles.detail}>{Math.round(row.percentage)}%</Text>
      ) : null}
    </>
  );
  return (
    <View>
      {items.length ? (
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={row.name}
          accessibilityState={accessibilityState}
          aria-expanded={isExpanded}
          onPress={handlePress}
          style={styles.row}
        >
          {content}
        </PressHighlight>
      ) : (
        <View style={styles.row}>{content}</View>
      )}
      {isExpanded
        ? items.map((item) => (
            <View key={item.name} style={styles.item}>
              <Text style={styles.itemName}>{item.name}</Text>
              <Text style={styles.detail}>
                {t("contextWindow.itemTokens", { tokens: formatTokenCount(item.tokens) })}
              </Text>
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: {
    gap: theme.spacing[1.5],
    minWidth: 200,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
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
  breakdown: { gap: theme.spacing[1] },
  bar: {
    flexDirection: "row",
    height: 8,
    overflow: "hidden",
    borderRadius: 4,
    backgroundColor: theme.colors.border,
  },
  segment: { height: "100%", backgroundColor: theme.colors.primary },
  deferred: { gap: theme.spacing[1], marginTop: theme.spacing[1] },
  row: { minHeight: 28, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  rowName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1 },
  item: { flexDirection: "row", justifyContent: "space-between", paddingLeft: theme.spacing[4] },
  itemName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
