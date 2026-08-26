import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { AgentStateBucketDot } from "@/components/agent-status-dot";
import {
  hasSidebarAgentRows,
  type SidebarAgentRows,
} from "@/components/sidebar/display-preferences/agent-rows";
import { useSidebarAgentRows } from "@/components/sidebar/display-preferences/model";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { isAgentListExpanded } from "@/stores/sidebar-collapsed-sections-store/state";
import type { Theme } from "@/styles/theme";
import type { WorkspaceAgentEntry } from "@/utils/workspace-agent-activity";
import { navigateToAgent } from "@/utils/navigate-to-agent";

/**
 * The agents inside one workspace row.
 *
 * Only drawn for a workspace holding more than one active root agent — see `agent-rows.ts` for
 * why. Both sidebar list modes mount this, so the rule and the layout live here rather than
 * twice in two row renderers.
 *
 * Rows carry a dot and a title and nothing else. The workspace row above already answered branch,
 * host, change request, and CI; repeating any of it per agent is what would make the sidebar
 * unreadable.
 */

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

export interface SidebarAgentListModel {
  agents: readonly WorkspaceAgentEntry[];
  /** Whether this workspace draws a disclosure and a list at all. */
  visible: boolean;
  expanded: boolean;
  toggle: () => void;
}

/**
 * The three fields both pieces need. `SidebarWorkspaceEntry` satisfies it structurally, so callers
 * pass the entry they already hold.
 */
export interface SidebarAgentListSource {
  workspaceKey: string;
  serverId: string;
  agents: readonly WorkspaceAgentEntry[];
}

export function useSidebarAgentListModel(input: SidebarAgentListSource): SidebarAgentListModel {
  const mode: SidebarAgentRows = useSidebarAgentRows();
  const expandedByDefault = mode === "expanded";
  const overrides = useSidebarCollapsedSectionsStore((state) => state.agentListOverrides);
  const toggleAgentListExpanded = useSidebarCollapsedSectionsStore(
    (state) => state.toggleAgentListExpanded,
  );

  const visible = hasSidebarAgentRows({ agentCount: input.agents.length, mode });
  const expanded = isAgentListExpanded(
    { agentListOverrides: overrides },
    input.workspaceKey,
    expandedByDefault,
  );

  const toggle = useCallback(() => {
    toggleAgentListExpanded(input.workspaceKey, expandedByDefault);
  }, [toggleAgentListExpanded, input.workspaceKey, expandedByDefault]);

  return useMemo(
    () => ({ agents: input.agents, visible, expanded, toggle }),
    [input.agents, visible, expanded, toggle],
  );
}

/**
 * The count and chevron that sit on the workspace row itself.
 *
 * Its own pressable rather than part of the row press: the row navigates to the workspace, and a
 * disclosure that navigated as a side effect of being opened would be a trap.
 */
export const SidebarAgentListDisclosure = memo(function SidebarAgentListDisclosure({
  workspace,
}: {
  workspace: SidebarAgentListSource;
}) {
  const { t } = useTranslation();
  const model = useSidebarAgentListModel(workspace);
  const accessibilityState = useMemo(() => ({ expanded: model.expanded }), [model.expanded]);
  if (!model.visible) {
    return null;
  }
  const Chevron = model.expanded ? ThemedChevronDown : ThemedChevronRight;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={t("sidebar.agentList.toggle", { count: model.agents.length })}
      onPress={model.toggle}
      style={styles.disclosure}
      testID="sidebar-agent-list-disclosure"
    >
      <Chevron size={12} uniProps={extraMutedColorMapping} />
      <Text style={styles.disclosureText}>{model.agents.length}</Text>
    </Pressable>
  );
});

export const SidebarWorkspaceAgentRows = memo(function SidebarWorkspaceAgentRows({
  workspace,
}: {
  workspace: SidebarAgentListSource;
}) {
  const model = useSidebarAgentListModel(workspace);
  if (!model.visible || !model.expanded) {
    return null;
  }
  return (
    <View style={styles.list} testID="sidebar-agent-list">
      {model.agents.map((agent) => (
        <SidebarAgentRow key={agent.agentId} serverId={workspace.serverId} agent={agent} />
      ))}
    </View>
  );
});

const SidebarAgentRow = memo(function SidebarAgentRow({
  serverId,
  agent,
}: {
  serverId: string;
  agent: WorkspaceAgentEntry;
}) {
  const { t } = useTranslation();
  const label = agent.title || t("agentList.fallbackTitle");

  const handlePress = useCallback(() => {
    navigateToAgent({ serverId, agentId: agent.agentId });
  }, [serverId, agent.agentId]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={handlePress}
      style={rowStyle}
      testID={`sidebar-agent-row-${agent.agentId}`}
    >
      <View style={styles.rowDot}>
        <AgentStateBucketDot bucket={agent.status} showInactive />
      </View>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});

const rowStyle = ({ pressed }: { pressed: boolean }) => [styles.row, pressed && styles.rowPressed];

const styles = StyleSheet.create((theme) => ({
  disclosure: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
    paddingHorizontal: theme.spacing[1],
    height: 20,
  },
  disclosureText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  list: {
    paddingLeft: theme.spacing[6],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    height: 24,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface1,
  },
  rowDot: {
    width: theme.spacing[2],
    alignItems: "center",
  },
  rowLabel: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
