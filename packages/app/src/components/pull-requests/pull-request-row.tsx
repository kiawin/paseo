import { Bot, ExternalLink, MoreVertical } from "lucide-react-native";
import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuItem, MenuLabel, MenuRoot, MenuSurface, useMenuContext } from "@/components/ui/menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { getForgePresentation } from "@/git/forge";
import type { PullRequestListRow } from "@/hooks/use-pull-requests";
import {
  describeAutoFixPause,
  describePullRequestBadges,
  type PullRequestAgentOption,
} from "@/pull-requests/pull-request-rows";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";
import { toErrorMessage } from "@/utils/error-messages";

// Module-scope themed icons: only the icon re-renders on theme change. See docs/unistyles.md.
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedBot = withUnistyles(Bot);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const MENU_ICON_SIZE = 14;
const AUTO_FIX_LABEL = "Auto-fix";
const NO_AGENT_HINT = "Start an agent in this workspace to use auto-fix";

export type SetAutoFix = (input: {
  serverId: string;
  agentId: string;
  enabled: boolean;
}) => Promise<void>;

interface PullRequestRowProps {
  row: PullRequestListRow;
  isFirst: boolean;
  showHostLabel: boolean;
  onOpen: (row: PullRequestListRow) => void;
  onSetAutoFix: SetAutoFix;
}

function buildMeta(row: PullRequestListRow, showHostLabel: boolean): string {
  const prefix = getForgePresentation(row.forge).numberPrefix;
  const reference = row.number === null ? null : `${prefix}${row.number}`;
  const identity = [row.repoLabel, reference].filter(Boolean).join(" ");
  const parts = [identity, row.workspaceName].filter((part) => part.length > 0);
  if (showHostLabel) parts.push(row.serverName);
  return parts.join(" · ");
}

/**
 * One open pull request as a card row: title, repository and workspace, status pills,
 * and a trailing Auto-fix switch plus a kebab for opening the PR on its forge. Pressing
 * the row opens the workspace.
 *
 * Hover lives on the outer plain View (docs/hover.md); the switch and kebab are nested
 * Pressables that stop propagation, so they never fire the row press.
 */
export function PullRequestRow({
  row,
  isFirst,
  showHostLabel,
  onOpen,
  onSetAutoFix,
}: PullRequestRowProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => onOpen(row), [onOpen, row]);

  const runSetAutoFix = useCallback(
    (agentId: string, enabled: boolean) => {
      setPending(true);
      setError(null);
      void onSetAutoFix({ serverId: row.serverId, agentId, enabled })
        .catch((cause: unknown) => setError(toErrorMessage(cause)))
        .finally(() => setPending(false));
    },
    [onSetAutoFix, row.serverId],
  );

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      isHovered && !isCompact && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst, isHovered, isCompact],
  );

  const badges = describePullRequestBadges(row);
  const { binding } = row;
  let note: string | null = null;
  if (binding.kind === "no-agent") note = NO_AGENT_HINT;
  else if (binding.kind === "agent" && binding.pausedReason !== null) {
    note = describeAutoFixPause(binding.pausedReason);
  }

  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={`Open workspace ${row.workspaceName}`}
        testID={`pull-request-row-${row.key}`}
      >
        <View style={styles.textGroup}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {row.title}
          </Text>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {buildMeta(row, showHostLabel)}
          </Text>
          {badges.length > 0 ? (
            <View style={styles.badges}>
              {badges.map((badge) => (
                <StatusBadge
                  key={badge.label}
                  label={badge.label}
                  variant={badge.variant}
                  size="xs"
                />
              ))}
            </View>
          ) : null}
          {note ? <Text style={settingsStyles.rowHint}>{note}</Text> : null}
          {error ? (
            <Text style={settingsStyles.rowError} testID={`pull-request-error-${row.key}`}>
              {error}
            </Text>
          ) : null}
        </View>

        <View style={styles.trailing}>
          <AutoFixControl row={row} pending={pending} onToggle={runSetAutoFix} />
          <PullRequestKebab row={row} />
        </View>
      </Pressable>
    </View>
  );
}

function AutoFixControl({
  row,
  pending,
  onToggle,
}: {
  row: PullRequestListRow;
  pending: boolean;
  onToggle: (agentId: string, enabled: boolean) => void;
}): ReactElement | null {
  const { binding } = row;
  const handleAgentToggle = useCallback(
    (enabled: boolean) => {
      if (binding.kind === "agent") onToggle(binding.agentId, enabled);
    },
    [binding, onToggle],
  );
  const handleChooseAgent = useCallback((agentId: string) => onToggle(agentId, true), [onToggle]);

  if (binding.kind === "unsupported") return null;

  let control: ReactElement;
  if (binding.kind === "choose") {
    control = (
      <AutoFixAgentPicker
        rowKey={row.key}
        agents={binding.agents}
        disabled={pending || !row.autoFixReady}
        onChoose={handleChooseAgent}
      />
    );
  } else {
    control = (
      <Switch
        value={binding.kind === "agent" && binding.enabled}
        onValueChange={handleAgentToggle}
        disabled={binding.kind === "no-agent" || pending || !row.autoFixReady}
        accessibilityLabel={AUTO_FIX_LABEL}
        testID={`pull-request-auto-fix-${row.key}`}
      />
    );
  }

  return (
    <View style={styles.autoFix}>
      <Text style={styles.autoFixLabel}>{AUTO_FIX_LABEL}</Text>
      {control}
    </View>
  );
}

/**
 * Several agents and none watching: the switch opens a menu to choose which agent
 * watches the PR. The menu anchors to the switch rather than owning a trigger, since
 * the switch is already a pressable (docs/menus.md, "a third trigger shape").
 */
function AutoFixAgentPicker({
  rowKey,
  agents,
  disabled,
  onChoose,
}: {
  rowKey: string;
  agents: readonly PullRequestAgentOption[];
  disabled: boolean;
  onChoose: (agentId: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const openPicker = useCallback(() => setOpen(true), []);
  return (
    <MenuRoot open={open} onOpenChange={setOpen} compactMode="sheet">
      <PickerAnchor>
        <Switch
          value={false}
          onValueChange={openPicker}
          disabled={disabled}
          accessibilityLabel={AUTO_FIX_LABEL}
          testID={`pull-request-auto-fix-${rowKey}`}
        />
      </PickerAnchor>
      <MenuSurface align="end" width={260} sheetTitle="Turn on auto-fix">
        <MenuLabel>Choose the agent that fixes this pull request</MenuLabel>
        {agents.map((agent) => (
          <AgentPickerItem key={agent.agentId} agent={agent} onChoose={onChoose} />
        ))}
      </MenuSurface>
    </MenuRoot>
  );
}

function AgentPickerItem({
  agent,
  onChoose,
}: {
  agent: PullRequestAgentOption;
  onChoose: (agentId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onChoose(agent.agentId), [agent.agentId, onChoose]);
  return (
    <MenuItem
      leading={agentLeading}
      onSelect={handleSelect}
      testID={`pull-request-auto-fix-agent-${agent.agentId}`}
    >
      {agent.title ?? "Untitled agent"}
    </MenuItem>
  );
}

function PickerAnchor({ children }: { children: ReactElement }): ReactElement {
  const { triggerRef } = useMenuContext("PickerAnchor");
  const anchor = useCallback(
    (node: View | null) => {
      Object.assign(triggerRef, { current: node });
    },
    [triggerRef],
  );
  return (
    <View ref={anchor} collapsable={false}>
      {children}
    </View>
  );
}

const agentLeading = <ThemedBot size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const openLeading = <ThemedExternalLink size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab
      size={MENU_ICON_SIZE}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

export interface PullRequestLinkTarget {
  key: string;
  forge: string;
  url: string;
}

/** Row kebab whose one item opens the pull request on its forge. */
export function PullRequestKebab({ row }: { row: PullRequestLinkTarget }): ReactElement {
  const brand = getForgePresentation(row.forge).brandLabel;
  const handleOpen = useCallback(() => {
    void openExternalUrl(row.url);
  }, [row.url]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel="Pull request actions"
        testID={`pull-request-kebab-${row.key}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem
          leading={openLeading}
          onSelect={handleOpen}
          testID={`pull-request-menu-open-${row.key}`}
        >
          {`Open on ${brand}`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  rowContainer: {
    position: "relative",
  },
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  badges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginTop: theme.spacing[2],
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  autoFix: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  autoFixLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
