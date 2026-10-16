import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProjectPrAutomation } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { CombinedModelSelector } from "@/components/combined-model-selector";
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
