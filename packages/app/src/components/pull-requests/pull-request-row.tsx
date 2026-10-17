import { Bot, ExternalLink, MoreVertical } from "lucide-react-native";
import { useCallback, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PullRequestRowFrame } from "@/components/pull-requests/pull-request-row-frame";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuItem, MenuLabel, MenuRoot, MenuSurface, useMenuContext } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { isNative } from "@/constants/platform";
import { getForgePresentation } from "@/git/forge";
import type { PullRequestListRow } from "@/hooks/use-pull-requests";
import {
  describeAutoFixPause,
  describePullRequestBadges,
  type PullRequestAgentOption,
} from "@/pull-requests/pull-request-rows";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { useOpenForgeLink } from "@/utils/use-link-behavior";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

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
 */
export function PullRequestRow({
  row,
  isFirst,
  showHostLabel,
  onOpen,
  onSetAutoFix,
}: PullRequestRowProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const { binding } = row;
  let note: string | null = null;
  if (binding.kind === "no-agent") note = NO_AGENT_HINT;
  else if (binding.kind === "agent" && binding.pausedReason !== null) {
    note = describeAutoFixPause(binding.pausedReason);
  }

  return (
    <PullRequestRowFrame
      testID={`pull-request-row-${row.key}`}
      isFirst={isFirst}
      title={row.title}
      meta={buildMeta(row, showHostLabel)}
      badges={describePullRequestBadges(row)}
      note={note}
      error={error}
      errorTestID={`pull-request-error-${row.key}`}
      accessibilityLabel={`Open workspace ${row.workspaceName}`}
      onPress={handlePress}
      trailing={
        <>
          <AutoFixControl row={row} pending={pending} onToggle={runSetAutoFix} />
          <PullRequestKebab
            row={row}
            workspaceKey={buildWorkspaceTabPersistenceKey({
              serverId: row.serverId,
              workspaceId: row.workspaceId,
            })}
          />
        </>
      }
    />
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

/** Anchors a controlled menu to a pressable that is already on screen (docs/menus.md). */
export function PickerAnchor({ children }: { children: ReactElement }): ReactElement {
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
export function PullRequestKebab({
  row,
  workspaceKey = null,
}: {
  row: PullRequestLinkTarget;
  workspaceKey?: string | null;
}): ReactElement {
  const brand = getForgePresentation(row.forge).brandLabel;
  const openForgeLink = useOpenForgeLink(workspaceKey);
  const handleOpen = useCallback(() => {
    openForgeLink(row.url);
  }, [openForgeLink, row.url]);
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
