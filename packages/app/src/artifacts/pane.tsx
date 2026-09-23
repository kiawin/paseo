import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ExternalLink, Pencil, Pin, PinOff, RotateCcw, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ArtifactRecordPayload } from "@getpaseo/protocol/messages";

import { useArtifactSearch, useProjectArtifacts, useWorkspaceProjectId } from "@/artifacts/hooks";
import { getArtifactDisplayTitle } from "@/artifacts/title";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { formatBytes } from "@/components/transfer-status";
import { PanelSearchFailure, PanelSearchField } from "@/components/panel-search";
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
import { useOpenAgentLink } from "@/utils/use-link-behavior";

const ThemedExternalLink = withUnistyles(ExternalLink, (theme) => ({
  color: theme.colors.mutedForeground,
}));
const ThemedPin = withUnistyles(Pin, (theme) => ({ color: theme.colors.mutedForeground }));
const ThemedPinOff = withUnistyles(PinOff, (theme) => ({ color: theme.colors.mutedForeground }));
const ThemedPencil = withUnistyles(Pencil, (theme) => ({ color: theme.colors.mutedForeground }));
const ThemedRotateCcw = withUnistyles(RotateCcw, (theme) => ({
  color: theme.colors.mutedForeground,
}));
const ThemedTrash2 = withUnistyles(Trash2, (theme) => ({ color: theme.colors.destructive }));

function ArtifactRow({
  artifact,
  snippet,
  onOpen,
  onOpenLink,
  renameSupported,
  onRename,
  onResetTitle,
  onTogglePin,
  onDelete,
}: {
  artifact: ArtifactRecordPayload;
  snippet: string | null;
  onOpen: (artifactId: string) => void;
  onOpenLink: (externalUrl: string) => void;
  renameSupported: boolean;
  onRename: (artifact: ArtifactRecordPayload) => void;
  onResetTitle: (artifact: ArtifactRecordPayload) => void;
  onTogglePin: (artifact: ArtifactRecordPayload) => void;
  onDelete: (artifact: ArtifactRecordPayload) => void;
}) {
  const { t } = useTranslation();
  const { artifactId, externalUrl } = artifact;
  const displayTitle = getArtifactDisplayTitle(artifact);
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
  const handleRename = useCallback(() => onRename(artifact), [artifact, onRename]);
  const handleResetTitle = useCallback(() => onResetTitle(artifact), [artifact, onResetTitle]);
  const handleTogglePin = useCallback(() => onTogglePin(artifact), [artifact, onTogglePin]);
  const handleDelete = useCallback(() => onDelete(artifact), [artifact, onDelete]);
  const pinLeading = useMemo(
    () => (artifact.pinned ? <ThemedPinOff size={16} /> : <ThemedPin size={16} />),
    [artifact.pinned],
  );
  const deleteLeading = useMemo(() => <ThemedTrash2 size={16} />, []);
  const renameLeading = useMemo(() => <ThemedPencil size={16} />, []);
  const resetLeading = useMemo(() => <ThemedRotateCcw size={16} />, []);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        style={styles.row}
        onPress={handleOpen}
        testID={`artifact-row-${artifactId}`}
        accessibilityRole="button"
        accessibilityLabel={
          artifact.pinned ? `${displayTitle}, ${t("panels.artifacts.pinned")}` : displayTitle
        }
      >
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {displayTitle}
          </Text>
          {artifact.pinned ? <ThemedPin size={12} /> : null}
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {meta}
        </Text>
        {snippet ? (
          <Text
            style={styles.rowSnippet}
            numberOfLines={2}
            testID={`artifact-snippet-${artifactId}`}
          >
            {snippet}
          </Text>
        ) : null}
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
        {renameSupported ? (
          <ContextMenuItem
            leading={renameLeading}
            onSelect={handleRename}
            testID={`artifact-rename-${artifactId}`}
          >
            {t("panels.artifacts.rename")}
          </ContextMenuItem>
        ) : null}
        {renameSupported && artifact.customTitle ? (
          <ContextMenuItem
            leading={resetLeading}
            onSelect={handleResetTitle}
            testID={`artifact-reset-title-${artifactId}`}
          >
            {t("panels.artifacts.useAgentTitle")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          leading={pinLeading}
          onSelect={handleTogglePin}
          testID={`artifact-pin-${artifactId}`}
        >
          {artifact.pinned ? t("panels.artifacts.unpin") : t("panels.artifacts.pin")}
        </ContextMenuItem>
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

function ArtifactSearchFailure({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <PanelSearchFailure
      testID="artifacts-search"
      message={t("panels.artifacts.searchFailed")}
      onRetry={onRetry}
    />
  );
}

function ArtifactRenameEditor({
  artifact,
  onRename,
  onClose,
}: {
  artifact: ArtifactRecordPayload;
  onRename: (artifactId: string, title: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const onSubmit = useCallback(
    (value: string) => onRename(artifact.artifactId, value.trim()),
    [artifact.artifactId, onRename],
  );
  return (
    <AdaptiveRenameModal
      visible
      title={t("panels.artifacts.renameTitle")}
      initialValue={getArtifactDisplayTitle(artifact)}
      placeholder={artifact.title}
      maxLength={200}
      onClose={onClose}
      onSubmit={onSubmit}
      testID={`artifact-rename-modal-${artifact.artifactId}`}
    />
  );
}

function ArtifactSearchResults({
  artifacts,
  snippetsById,
  pending,
  failed,
  contentSearchSupported,
  hasQuery,
  onRetry,
  onOpen,
  onOpenLink,
  renameSupported,
  onRename,
  onResetTitle,
  onTogglePin,
  onDelete,
}: {
  artifacts: ArtifactRecordPayload[];
  snippetsById: ReadonlyMap<string, string | null>;
  pending: boolean;
  failed: boolean;
  contentSearchSupported: boolean;
  hasQuery: boolean;
  onRetry: () => void;
  onOpen: (artifactId: string) => void;
  onOpenLink: (externalUrl: string) => void;
  renameSupported: boolean;
  onRename: (artifact: ArtifactRecordPayload) => void;
  onResetTitle: (artifact: ArtifactRecordPayload) => void;
  onTogglePin: (artifact: ArtifactRecordPayload) => void;
  onDelete: (artifact: ArtifactRecordPayload) => void;
}) {
  const { t } = useTranslation();
  if (artifacts.length === 0) {
    if (pending) {
      return (
        <View style={styles.centerState} testID="artifacts-searching">
          <Text style={styles.emptyTitle}>{t("panels.artifacts.searchingText")}</Text>
        </View>
      );
    }
    if (failed) {
      return (
        <View style={styles.centerState}>
          <ArtifactSearchFailure onRetry={onRetry} />
        </View>
      );
    }
    return (
      <View style={styles.centerState} testID="artifacts-no-results">
        <Text style={styles.emptyTitle}>{t("common.empty.noResults")}</Text>
        {!contentSearchSupported && hasQuery ? (
          <Text style={styles.emptyBody}>{t("panels.artifacts.updateForTextSearch")}</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {pending ? (
        <Text style={styles.searchStatus} testID="artifacts-search-status">
          {t("panels.artifacts.searchingText")}
        </Text>
      ) : null}
      {failed ? <ArtifactSearchFailure onRetry={onRetry} /> : null}
      <ScrollView style={styles.list} testID="artifacts-list" keyboardShouldPersistTaps="handled">
        {artifacts.map((artifact) => (
          <ArtifactRow
            key={artifact.artifactId}
            artifact={artifact}
            snippet={snippetsById.get(artifact.artifactId) ?? null}
            onOpen={onOpen}
            onOpenLink={onOpenLink}
            renameSupported={renameSupported}
            onRename={onRename}
            onResetTitle={onResetTitle}
            onTogglePin={onTogglePin}
            onDelete={onDelete}
          />
        ))}
      </ScrollView>
    </View>
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
  const { artifacts, isLoading, error, supported, renameSupported, remove, setPinned, rename } =
    useProjectArtifacts(serverId, projectId);
  const [searchQuery, setSearchQuery] = useState("");
  const [renamingArtifact, setRenamingArtifact] = useState<ArtifactRecordPayload | null>(null);
  const search = useArtifactSearch(serverId, projectId, artifacts, searchQuery);
  const searchLabel = search.contentSearchSupported
    ? t("panels.artifacts.searchTitlesAndText")
    : t("panels.artifacts.searchTitles");
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const onOpenLink = useOpenAgentLink(workspaceKey);
  const onRename = useCallback(
    (artifact: ArtifactRecordPayload) => setRenamingArtifact(artifact),
    [],
  );
  const onCloseRename = useCallback(() => setRenamingArtifact(null), []);
  const onResetTitle = useCallback(
    (artifact: ArtifactRecordPayload) => {
      void rename(artifact.artifactId, null).catch(() => {
        toast.error(t("panels.artifacts.renameFailed"));
      });
    },
    [rename, t, toast],
  );
  const onTogglePin = useCallback(
    (artifact: ArtifactRecordPayload) => {
      void (async () => {
        try {
          await setPinned(artifact.artifactId, !artifact.pinned);
        } catch {
          toast.error(t("panels.artifacts.pinFailed"));
        }
      })();
    },
    [setPinned, t, toast],
  );
  const onDelete = useCallback(
    (artifact: ArtifactRecordPayload) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("panels.artifacts.deleteTitle"),
          message: t("panels.artifacts.deleteMessage", {
            title: getArtifactDisplayTitle(artifact),
          }),
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
    <View style={styles.container}>
      <PanelSearchField
        testID="artifacts-search"
        label={searchLabel}
        onChangeText={setSearchQuery}
      />
      <ArtifactSearchResults
        artifacts={search.matchingArtifacts}
        snippetsById={search.snippetsById}
        pending={search.pending}
        failed={search.failed}
        contentSearchSupported={search.contentSearchSupported}
        hasQuery={search.hasQuery}
        onRetry={search.retry}
        onOpen={onOpenArtifact}
        onOpenLink={onOpenLink}
        renameSupported={renameSupported}
        onRename={onRename}
        onResetTitle={onResetTitle}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
      {renamingArtifact ? (
        <ArtifactRenameEditor
          key={renamingArtifact.artifactId}
          artifact={renamingArtifact}
          onRename={rename}
          onClose={onCloseRename}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  searchStatus: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    marginHorizontal: theme.spacing[3],
  },
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
  rowSnippet: {
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
