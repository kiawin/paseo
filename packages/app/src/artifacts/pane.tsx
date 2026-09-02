import { useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ExternalLink, Pin } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ArtifactRecordPayload } from "@getpaseo/protocol/messages";

import { useProjectArtifacts, useWorkspaceProjectId } from "@/artifacts/hooks";
import { formatBytes } from "@/components/transfer-status";
import { externalLinkHost } from "@/utils/external-link-host";
import { formatTimeAgo } from "@/utils/time";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedExternalLink = withUnistyles(ExternalLink, (theme) => ({
  color: theme.colors.mutedForeground,
}));
const ThemedPin = withUnistyles(Pin, (theme) => ({ color: theme.colors.mutedForeground }));

function ArtifactRow({
  artifact,
  onOpen,
  onOpenLink,
}: {
  artifact: ArtifactRecordPayload;
  onOpen: (artifactId: string) => void;
  onOpenLink: (externalUrl: string) => void;
}) {
  const { artifactId, externalUrl } = artifact;
  const host = externalUrl ? externalLinkHost(externalUrl) : null;
  const meta = `${formatBytes(artifact.size)} · ${formatTimeAgo(new Date(artifact.updatedAt))}`;
  const handleOpen = useCallback(() => onOpen(artifactId), [artifactId, onOpen]);
  const handleOpenLink = useCallback(() => {
    if (externalUrl) onOpenLink(externalUrl);
  }, [externalUrl, onOpenLink]);
  return (
    <Pressable style={styles.row} onPress={handleOpen} testID={`artifact-row-${artifactId}`}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {artifact.title}
        </Text>
        {artifact.pinned ? <ThemedPin size={12} /> : null}
      </View>
      <Text style={styles.rowMeta} numberOfLines={1}>
        {meta}
      </Text>
      {externalUrl && host ? (
        <Pressable
          style={styles.linkRow}
          onPress={handleOpenLink}
          testID={`artifact-link-${artifactId}`}
        >
          <ThemedExternalLink size={12} />
          <Text style={styles.linkText} numberOfLines={1}>
            {host}
          </Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/**
 * The project's artifact list. Shared by the Explorer pane on desktop and the compact
 * overlay's Artifacts tab, which do not share chrome but do show the same rows.
 */
export function ArtifactsPane({
  serverId,
  workspaceId,
  onOpenArtifact,
}: {
  serverId: string;
  workspaceId: string | null;
  onOpenArtifact: (artifactId: string) => void;
}) {
  const { t } = useTranslation();
  const projectId = useWorkspaceProjectId(serverId, workspaceId ?? null);
  const { artifacts, isLoading, error, supported } = useProjectArtifacts(serverId, projectId);

  const onOpenLink = useCallback((externalUrl: string) => {
    void openExternalUrl(externalUrl);
  }, []);

  if (!supported) {
    return (
      <View style={styles.centerState} testID="artifacts-unsupported">
        <Text style={styles.emptyTitle}>{t("panels.artifacts.hostTooOld")}</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centerState} testID="artifacts-error">
        <Text style={styles.emptyTitle}>{t("panels.artifacts.loadFailed")}</Text>
        <Text style={styles.emptyBody}>{error}</Text>
      </View>
    );
  }
  if (artifacts.length === 0) {
    return (
      <View style={styles.centerState} testID="artifacts-empty">
        <Text style={styles.emptyTitle}>
          {isLoading ? t("common.states.loading") : t("panels.artifacts.emptyTitle")}
        </Text>
        {isLoading ? null : (
          <Text style={styles.emptyBody}>{t("panels.artifacts.emptyDescription")}</Text>
        )}
      </View>
    );
  }
  return (
    <ScrollView style={styles.list} testID="artifacts-list">
      {artifacts.map((artifact) => (
        <ArtifactRow
          key={artifact.artifactId}
          artifact={artifact}
          onOpen={onOpenArtifact}
          onOpenLink={onOpenLink}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
  },
  row: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: 2,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  rowTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowMeta: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  linkText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  emptyBody: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));
