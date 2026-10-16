import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProjectPrAutomation } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingsGroup } from "@/components/settings/headings/settings-group";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  DEFAULT_PR_AUTOMATION,
  formatReviewProvider,
  parseReviewProvider,
} from "@/projects/pr-automation";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** When a reviewer looks again; the daemon treats an absent value as "request". */
const RE_REVIEW_OPTIONS = ["request", "push"] as const;
type ReReviewOn = (typeof RE_REVIEW_OPTIONS)[number];

const RE_REVIEW_LABELS: Record<ReReviewOn, string> = {
  request: "settings.project.prAutomation.reReviewOnRequest",
  push: "settings.project.prAutomation.reReviewOnPush",
};

function reReviewOf(settings: ProjectPrAutomation): ReReviewOn {
  return settings.reReviewOn === "push" ? "push" : "request";
}

function dropdownTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

interface ReReviewMenuItemProps {
  value: ReReviewOn;
  selected: boolean;
  onChange: (value: ReReviewOn) => void;
}

function ReReviewMenuItem({ value, selected, onChange }: ReReviewMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {t(RE_REVIEW_LABELS[value])}
    </DropdownMenuItem>
  );
}

interface ReReviewRowProps {
  value: ReReviewOn;
  disabled: boolean;
  onChange: (value: ReReviewOn) => void;
}

function ReReviewRow({ value, disabled, onChange }: ReReviewRowProps) {
  const { t } = useTranslation();
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.project.prAutomation.reReview")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.project.prAutomation.reReviewHint")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          disabled={disabled}
          testID="pr-automation-re-review"
          accessibilityLabel={t("settings.project.prAutomation.reReview")}
        >
          <Text style={styles.triggerText}>{t(RE_REVIEW_LABELS[value])}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={260}>
          {RE_REVIEW_OPTIONS.map((option) => (
            <ReReviewMenuItem
              key={option}
              value={option}
              selected={option === value}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

type SwitchField = "autoFixAgentPullRequests" | "autoReview" | "postReviews";

const SWITCH_COPY: Record<SwitchField, { title: string; hint: string; testID: string }> = {
  autoFixAgentPullRequests: {
    title: "settings.project.prAutomation.autoFix",
    hint: "settings.project.prAutomation.autoFixHint",
    testID: "pr-automation-auto-fix",
  },
  autoReview: {
    title: "settings.project.prAutomation.autoReview",
    hint: "settings.project.prAutomation.autoReviewHint",
    testID: "pr-automation-auto-review",
  },
  postReviews: {
    title: "settings.project.prAutomation.postReviews",
    hint: "settings.project.prAutomation.postReviewsHint",
    testID: "pr-automation-post-reviews",
  },
};

interface SwitchRowProps {
  field: SwitchField;
  value: boolean;
  disabled: boolean;
  isFirst: boolean;
  onChange: (field: SwitchField, value: boolean) => void;
}

function SwitchRow({ field, value, disabled, isFirst, onChange }: SwitchRowProps) {
  const { t } = useTranslation();
  const copy = SWITCH_COPY[field];
  const handleChange = useCallback((next: boolean) => onChange(field, next), [field, onChange]);
  return (
    <View style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t(copy.title)}</Text>
        <Text style={settingsStyles.rowHint}>{t(copy.hint)}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={handleChange}
        disabled={disabled}
        accessibilityLabel={t(copy.title)}
        testID={copy.testID}
      />
    </View>
  );
}

export interface PrAutomationSectionProps {
  client: Pick<DaemonClient, "setProjectPrAutomation">;
  serverId: string;
  projectId: string;
  repoRoot: string;
  settings: ProjectPrAutomation | null;
}

/**
 * Host-local like the worktree location, so every control writes straight through
 * its own RPC instead of joining the paseo.json draft the rest of the screen saves.
 * Controls lock while a write is in flight: each write sends the whole settings
 * object, so a second change built on an unconfirmed first one could undo it.
 */
export function PrAutomationSection({
  client,
  serverId,
  projectId,
  repoRoot,
  settings,
}: PrAutomationSectionProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  // The host's descriptor is the source of truth; it arrives after the screen
  // mounts and updates when any client saves. Only an unconfirmed save overrides it.
  const [pending, setPending] = useState<ProjectPrAutomation | null>(null);
  const current = pending ?? settings ?? DEFAULT_PR_AUTOMATION;
  // A new descriptor from the host supersedes whatever this screen saved.
  useEffect(() => {
    setPending(null);
  }, [settings]);
  const [error, setError] = useState<string | null>(null);

  const snapshot = useProvidersSnapshot(serverId, { cwd: repoRoot });
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const reviewer = parseReviewProvider(current.reviewProvider);

  const mutation = useMutation({
    mutationFn: (next: ProjectPrAutomation) => client.setProjectPrAutomation(projectId, next),
    onMutate: (next: ProjectPrAutomation) => {
      setError(null);
      setPending(next);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (mutationError: unknown) => {
      setPending(null);
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : t("settings.project.prAutomation.saveFailed"),
      );
      toast.show(t("settings.project.prAutomation.saveFailed"), { variant: "error" });
    },
  });
  const { mutate, isPending } = mutation;

  const handleSwitch = useCallback(
    (field: SwitchField, value: boolean) => mutate({ ...current, [field]: value }),
    [current, mutate],
  );
  const handleSelectReviewer = useCallback(
    (provider: AgentProvider, model: string) =>
      mutate({ ...current, reviewProvider: formatReviewProvider({ provider, model }) }),
    [current, mutate],
  );
  const handleReReviewChange = useCallback(
    (reReviewOn: ReReviewOn) => mutate({ ...current, reReviewOn }),
    [current, mutate],
  );
  const handleSelectorOpen = useCallback(() => {
    snapshot.refetchIfStale(reviewer?.provider);
  }, [reviewer?.provider, snapshot]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => snapshot.refresh([provider]),
    [snapshot],
  );

  return (
    <SettingsGroup
      title={t("settings.project.prAutomation.title")}
      info={t("settings.project.prAutomation.info")}
      testID="pr-automation-group"
    >
      <View style={settingsStyles.card}>
        <SwitchRow
          field="autoFixAgentPullRequests"
          value={current.autoFixAgentPullRequests}
          disabled={isPending}
          isFirst
          onChange={handleSwitch}
        />
        <SwitchRow
          field="autoReview"
          value={current.autoReview}
          disabled={isPending}
          isFirst={false}
          onChange={handleSwitch}
        />
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.project.prAutomation.reviewer")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.project.prAutomation.reviewerHint")}
            </Text>
          </View>
          <CombinedModelSelector
            providers={providers}
            selectedProvider={reviewer?.provider ?? ""}
            selectedModel={reviewer?.model ?? ""}
            onSelect={handleSelectReviewer}
            isLoading={snapshot.isLoading || snapshot.isFetching}
            onOpen={handleSelectorOpen}
            onRetryProvider={handleRetryProvider}
            isRetryingProvider={snapshot.isRefreshing}
            disabled={isPending}
            serverId={serverId}
            desktopPlacement="bottom-start"
            desktopMinWidth={360}
          />
        </View>
        <ReReviewRow
          value={reReviewOf(current)}
          disabled={isPending}
          onChange={handleReReviewChange}
        />
        <SwitchRow
          field="postReviews"
          value={current.postReviews}
          disabled={isPending}
          isFirst={false}
          onChange={handleSwitch}
        />
        {error ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={settingsStyles.rowError} testID="pr-automation-error">
              {error}
            </Text>
          </View>
        ) : null}
      </View>
    </SettingsGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: {
    opacity: 0.85,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
