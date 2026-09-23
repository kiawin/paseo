import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { SettingsGroup } from "@/components/settings/headings/settings-group";
import { settingsStyles } from "@/styles/settings";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { copyProjectBetweenHosts } from "@/projects/copy-between-hosts";
import type { ProjectHostEntry, ProjectSummary } from "@/utils/projects";

export interface CopyFromHostSectionProps {
  project: ProjectSummary;
  target: ProjectHostEntry;
  targetClient: DaemonClient;
}

interface CopyRequest {
  source: ProjectHostEntry;
  sourceClient: DaemonClient;
  includeNotes: boolean;
}

/**
 * Copies artifacts and notes from another host of the same project into this one. Hidden when the
 * project lives on only this host — there is nothing to copy from.
 *
 * One copy at a time per target: two running at once would each snapshot the target before the
 * other wrote, and both would copy what they share.
 */
export function CopyFromHostSection({ project, target, targetClient }: CopyFromHostSectionProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const canPublish = useHostFeature(target.serverId, "artifactPublish");
  const targetPinsNotes = useHostFeature(target.serverId, "notePin");
  const targetArchivesNotes = useHostFeature(target.serverId, "noteArchive");
  const sources = useMemo(
    () => project.hosts.filter((host) => host.serverId !== target.serverId),
    [project.hosts, target.serverId],
  );

  const copy = useMutation({
    mutationFn: ({ source, sourceClient, includeNotes }: CopyRequest) =>
      copyProjectBetweenHosts({
        source: { client: sourceClient, projectId: source.projectId },
        target: { client: targetClient, projectId: target.projectId },
        includeNotes,
        pinNotes: targetPinsNotes,
        archiveNotes: targetArchivesNotes,
      }),
    onSuccess: (result) => {
      const counts = {
        artifacts: result.artifactsCopied,
        notes: result.notesCopied,
        skipped: result.skipped,
        failed: result.failures.length,
      };
      if (result.failures.length > 0) {
        console.error("[CopyFromHost] Some items were not copied", result.failures);
        toast.show(t("settings.project.copyFromHost.doneWithFailures", counts), {
          variant: "warning",
          durationMs: null,
        });
        return;
      }
      toast.show(t("settings.project.copyFromHost.done", counts), { variant: "success" });
    },
    onError: (error) => {
      toast.show(
        t("settings.project.copyFromHost.failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        { variant: "error" },
      );
    },
  });
  const copyingServerId = copy.isPending ? (copy.variables?.source.serverId ?? null) : null;

  if (sources.length === 0) return null;

  return (
    <SettingsGroup
      title={t("settings.project.copyFromHost.title")}
      info={t("settings.project.copyFromHost.info", { host: target.serverName })}
      testID="copy-from-host-group"
    >
      <View style={settingsStyles.card}>
        {sources.map((source, index) => (
          <CopyFromHostRow
            key={`${source.serverId}:${source.projectId}`}
            source={source}
            canPublish={canPublish}
            isBusy={copy.isPending}
            isCopying={copyingServerId === source.serverId}
            onCopy={copy.mutate}
            isFirst={index === 0}
          />
        ))}
      </View>
    </SettingsGroup>
  );
}

interface CopyFromHostRowProps {
  source: ProjectHostEntry;
  canPublish: boolean;
  isBusy: boolean;
  isCopying: boolean;
  onCopy: (request: CopyRequest) => void;
  isFirst: boolean;
}

function CopyFromHostRow({
  source,
  canPublish,
  isBusy,
  isCopying,
  onCopy,
  isFirst,
}: CopyFromHostRowProps) {
  const { t } = useTranslation();
  const sourceClient = useHostRuntimeClient(source.serverId);
  const sourceHasArtifacts = useHostFeature(source.serverId, "artifacts");
  const sourceHasNotes = useHostFeature(source.serverId, "notes");

  const handleCopy = useCallback(() => {
    if (sourceClient) onCopy({ source, sourceClient, includeNotes: sourceHasNotes });
  }, [onCopy, source, sourceClient, sourceHasNotes]);

  let hint = t("settings.project.copyFromHost.hint");
  if (!canPublish) hint = t("settings.project.copyFromHost.updateHost");
  else if (!source.isOnline || !sourceClient) {
    hint = t("settings.project.copyFromHost.offline", { host: source.serverName });
  } else if (!sourceHasArtifacts) {
    hint = t("settings.project.copyFromHost.updateSource", { host: source.serverName });
  }
  const canCopy = canPublish && source.isOnline && sourceClient !== null && sourceHasArtifacts;

  return (
    <View style={isFirst ? settingsStyles.row : [settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.project.copyFromHost.rowTitle", { host: source.serverName })}
        </Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={handleCopy}
        disabled={isBusy || !canCopy}
        testID={`copy-from-host-button-${source.serverId}`}
      >
        {isCopying
          ? t("settings.project.copyFromHost.copying")
          : t("settings.project.copyFromHost.copy")}
      </Button>
    </View>
  );
}
