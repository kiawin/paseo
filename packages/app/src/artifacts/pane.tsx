import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ExternalLink, Pin, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ArtifactRecordPayload } from "@getpaseo/protocol/messages";

import { useProjectArtifacts, useWorkspaceProjectId } from "@/artifacts/hooks";
import { formatBytes } from "@/components/transfer-status";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { externalLinkHost } from "@/utils/external-link-host";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatTimeAgo } from "@/utils/time";
import { useOpenAgentLink } from "@/utils/use-agent-link-behavior";

const ThemedExternalLink = withUnistyles(ExternalLink, (theme) => ({
  color: theme.colors.mutedForeground,
}));
const ThemedPin = withUnistyles(Pin, (theme) => ({ color: theme.colors.mutedForeground }));
const ThemedTrash2 = withUnistyles(Trash2, (theme) => ({ color: theme.colors.destructive }));

function ArtifactRow({
  artifact,
  onOpen,
  onOpenLink,
  onDelete,
}: {
  artifact: ArtifactRecordPayload;
  onOpen: (artifactId: string) => void;
  onOpenLink: (externalUrl: string) => void;
  onDelete: (artifact: ArtifactRecordPayload) => void;
}) {
  const { t } = useTranslation();
  const { artifactId, externalUrl } = artifact;
  const host = externalUrl ? externalLinkHost(externalUrl) : null;
  // A link-only artifact has nothing to preview, so the row is the link.
  const isStored = artifact.contentSha256 !== null;
  const age = formatTimeAgo(new Date(artifact.updatedAt));
  const meta = artifact.size === null ? age : `${formatBytes(artifact.size)} · ${age}`;
  const handleOpen = useCallback(() => {
    if (isStored) {
      onOpen(artifactId);
      return;
    }
    if (externalUrl) onOpenLink(externalUrl);
  }, [artifactId, externalUrl, isStored, onOpen, onOpenLink]);
  const handleOpenLink = useCallback(() => {
    if (externalUrl) onOpenLink(externalUrl);
  }, [externalUrl, onOpenLink]);
  const handleDelete = useCallback(() => onDelete(artifact), [artifact, onDelete]);
  const deleteLeading = useMemo(() => <ThemedTrash2 size={16} />, []);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        style={styles.row}
        onPress={handleOpen}
        testID={`artifact-row-${artifactId}`}
        accessibilityRole="button"
        accessibilityLabel={artifact.title}
      >
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
      </ContextMenuTrigger>
      <ContextMenuContent width={180} testID={`artifact-menu-${artifactId}`}>
        <ContextMenuItem
          destructive
          leading={deleteLeading}
          onSelect={handleDelete}
          testID={`artifact-delete-${artifactId}`}
        >
          {t("panels.artifacts.deleteConfirm")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
  const toast = useToast();
  const projectId = useWorkspaceProjectId(serverId, workspaceId ?? null);
  const { artifacts, isLoading, error, supported, remove } = useProjectArtifacts(
    serverId,
    projectId,
  );
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const onOpenLink = useOpenAgentLink(workspaceKey);
  const onDelete = useCallback(
    (artifact: ArtifactRecordPayload) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("panels.artifacts.deleteTitle"),
          message: t("panels.artifacts.deleteMessage", { title: artifact.title }),
          confirmLabel: t("panels.artifacts.deleteConfirm"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) return;
        try {
          await remove(artifact.artifactId);
        } catch {
          toast.error(t("panels.artifacts.deleteFailed"));
        }
      })();
    },
    [remove, t, toast],
  );

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
          onDelete={onDelete}
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
