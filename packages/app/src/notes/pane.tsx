import { Fragment, useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Archive, ArchiveRestore, Pin, PinOff } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import {
  useNoteSearch,
  useProjectNotes,
  useSetNoteArchived,
  useSetNotePinned,
} from "@/notes/hooks";
import {
  groupFederatedNotesByHost,
  noteTargetForRow,
  type FederatedNoteRecord,
  type NoteHostError,
  type NoteTarget,
} from "@/notes/federation";
import { noteRowKey } from "@/notes/search";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  filterByArchiveScope,
  PanelSearchFailure,
  PanelSearchField,
  type ArchiveScope,
} from "@/components/panel-search";
import { useToast } from "@/contexts/toast-context";
import { isWeb } from "@/constants/platform";
import { useHostFeatureMap } from "@/runtime/host-features";
import { formatTimeAgo } from "@/utils/time";

const ThemedPin = withUnistyles(Pin, (theme) => ({ color: theme.colors.mutedForeground }));
const ThemedPinOff = withUnistyles(PinOff, (theme) => ({ color: theme.colors.mutedForeground }));
const ThemedArchive = withUnistyles(Archive, (theme) => ({ color: theme.colors.mutedForeground }));
const ThemedArchiveRestore = withUnistyles(ArchiveRestore, (theme) => ({
  color: theme.colors.mutedForeground,
}));

function NoteRow({
  note,
  snippet,
  pinSupported,
  archiveSupported,
  onOpen,
  onTogglePin,
  onToggleArchive,
}: {
  note: FederatedNoteRecord;
  snippet: string | null;
  pinSupported: boolean;
  archiveSupported: boolean;
  onOpen: (target: NoteTarget) => void;
  onTogglePin: (note: FederatedNoteRecord) => void;
  onToggleArchive: (note: FederatedNoteRecord) => void;
}) {
  const { t } = useTranslation();
  const pinned = note.pinned === true;
  const archived = note.archived === true;
  let stateLabel: string | null = null;
  if (pinned) stateLabel = t("panels.notes.pinned");
  else if (archived) stateLabel = t("panels.notes.archived");
  const handleOpen = useCallback(() => onOpen(noteTargetForRow(note)), [note, onOpen]);
  const handleTogglePin = useCallback(() => onTogglePin(note), [note, onTogglePin]);
  const handleToggleArchive = useCallback(() => onToggleArchive(note), [note, onToggleArchive]);
  const pinLeading = useMemo(
    () => (pinned ? <ThemedPinOff size={16} /> : <ThemedPin size={16} />),
    [pinned],
  );
  const archiveLeading = useMemo(
    () => (archived ? <ThemedArchiveRestore size={16} /> : <ThemedArchive size={16} />),
    [archived],
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger
        style={styles.row}
        onPress={handleOpen}
        testID={`note-row-${note.noteId}`}
        accessibilityRole="button"
        accessibilityLabel={stateLabel ? `${note.displayTitle}, ${stateLabel}` : note.displayTitle}
      >
        <View style={styles.rowHeader}>
          <Text style={[styles.rowTitle, archived && styles.rowTitleArchived]} numberOfLines={1}>
            {note.displayTitle}
          </Text>
          {pinned ? <ThemedPin size={12} /> : null}
          {archived ? <ThemedArchive size={12} /> : null}
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {t("panels.notes.hostTag", { host: note.serverName })} ·{" "}
          {t("panels.notes.updated", {
            time: formatTimeAgo(new Date(note.updatedAt)),
          })}
        </Text>
        {snippet ? (
          <Text style={styles.rowMeta} numberOfLines={2} testID={`note-snippet-${note.noteId}`}>
            {snippet}
          </Text>
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent width={200} testID={`note-menu-${note.noteId}`}>
        {archived ? null : (
          <ContextMenuItem
            leading={pinLeading}
            onSelect={handleTogglePin}
            disabled={!pinSupported}
            description={
              pinSupported ? undefined : t("panels.notes.pinUnsupported", { host: note.serverName })
            }
            testID={`note-pin-${note.noteId}`}
          >
            {pinned ? t("panels.notes.unpin") : t("panels.notes.pin")}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          leading={archiveLeading}
          onSelect={handleToggleArchive}
          disabled={!archiveSupported}
          description={
            archiveSupported
              ? undefined
              : t("panels.notes.archiveUnsupported", { host: note.serverName })
          }
          testID={`note-archive-${note.noteId}`}
        >
          {archived ? t("panels.notes.unarchive") : t("panels.notes.archive")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function HostErrorsNotice({ errors }: { errors: NoteHostError[] }) {
  const { t } = useTranslation();
  if (errors.length === 0) return null;
  return (
    <Alert
      testID="notes-host-errors"
      variant="warning"
      title={t("panels.notes.hostsUnavailable")}
      description={errors
        .map((error) => {
          if (error.reason === "unsupported") {
            return t("panels.notes.hostUnsupported", { host: error.serverName });
          }
          if (error.reason === "failed") {
            return t("panels.notes.hostLoadFailed", { host: error.serverName });
          }
          return t("panels.notes.hostUnreachable", { host: error.serverName });
        })
        .join(" ")}
    />
  );
}

function StateView({
  testID,
  title,
  body,
  onRetry,
}: {
  testID: string;
  title: string;
  body?: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID={testID}>
      <Text style={styles.stateTitle}>{title}</Text>
      {body ? <Text style={styles.stateBody}>{body}</Text> : null}
      {onRetry ? (
        <Button size="sm" variant="secondary" onPress={onRetry} testID={`${testID}-retry`}>
          {t("common.actions.retry")}
        </Button>
      ) : null}
    </View>
  );
}

function CreateNoteButton({ label, onCreateNote }: { label: string; onCreateNote?: () => void }) {
  if (!isWeb || !onCreateNote) return null;
  return (
    <Button size="sm" variant="secondary" onPress={onCreateNote} testID="new-note">
      {label}
    </Button>
  );
}

function NoteResults({
  hasVisibleNotes,
  search,
  pinSupportedByServerId,
  archiveSupportedByServerId,
  onOpenNote,
  onTogglePin,
  onToggleArchive,
}: {
  hasVisibleNotes: boolean;
  search: ReturnType<typeof useNoteSearch>;
  pinSupportedByServerId: ReadonlyMap<string, boolean>;
  archiveSupportedByServerId: ReadonlyMap<string, boolean>;
  onOpenNote: (target: NoteTarget) => void;
  onTogglePin: (note: FederatedNoteRecord) => void;
  onToggleArchive: (note: FederatedNoteRecord) => void;
}) {
  const { t } = useTranslation();
  if (!hasVisibleNotes) {
    return (
      <StateView
        testID="notes-no-active"
        title={t("panels.notes.noActiveTitle")}
        body={t("panels.notes.noActiveDescription")}
      />
    );
  }
  if (search.matchingNotes.length === 0) {
    return (
      <StateView
        testID="notes-no-results"
        title={t("common.empty.noResults")}
        body={
          search.hasQuery && !search.textSearchEverywhere
            ? t("panels.notes.updateForTextSearch")
            : undefined
        }
      />
    );
  }
  return (
    <ScrollView style={styles.list} testID="notes-list" keyboardShouldPersistTaps="handled">
      {groupFederatedNotesByHost(search.matchingNotes).map((group) => (
        <Fragment key={group.serverId}>
          <Text style={styles.hostHeading} testID={`notes-host-${group.serverId}`}>
            {t("panels.notes.hostHeading", { host: group.serverName })}
          </Text>
          {group.notes.map((note) => (
            <NoteRow
              key={noteRowKey(note)}
              note={note}
              snippet={search.snippets.get(noteRowKey(note)) ?? null}
              pinSupported={pinSupportedByServerId.get(note.serverId) === true}
              archiveSupported={archiveSupportedByServerId.get(note.serverId) === true}
              onOpen={onOpenNote}
              onTogglePin={onTogglePin}
              onToggleArchive={onToggleArchive}
            />
          ))}
        </Fragment>
      ))}
    </ScrollView>
  );
}

export function NotesPane({
  serverId,
  workspaceId,
  onOpenNote,
  onCreateNote,
}: {
  serverId: string;
  workspaceId: string | null;
  onOpenNote: (target: NoteTarget) => void;
  onCreateNote?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { hosts, notes, hostErrors, supported, connectionStatus, isLoading, error, refetch } =
    useProjectNotes(serverId, workspaceId);
  const [searchQuery, setSearchQuery] = useState("");
  const [archiveScope, setArchiveScope] = useState<ArchiveScope>("active");
  const visibleNotes = useMemo(
    () => filterByArchiveScope(notes, archiveScope),
    [notes, archiveScope],
  );
  const search = useNoteSearch(hosts, visibleNotes, searchQuery);
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const pinSupportedByServerId = useHostFeatureMap(serverIds, "notePin");
  const archiveSupportedByServerId = useHostFeatureMap(serverIds, "noteArchive");
  const anyHostArchives = useMemo(
    () => [...archiveSupportedByServerId.values()].some(Boolean),
    [archiveSupportedByServerId],
  );
  const archiveScopeControl = useMemo(
    () => (anyHostArchives ? { value: archiveScope, onValueChange: setArchiveScope } : undefined),
    [anyHostArchives, archiveScope],
  );
  const setArchived = useSetNoteArchived();
  const onToggleArchive = useCallback(
    (note: FederatedNoteRecord) => {
      setArchived(note, note.archived !== true).catch(() => {
        toast.error(t("panels.notes.archiveFailed"));
      });
    },
    [setArchived, t, toast],
  );
  const setPinned = useSetNotePinned();
  const onTogglePin = useCallback(
    (note: FederatedNoteRecord) => {
      setPinned(note, note.pinned !== true).catch(() => {
        toast.error(t("panels.notes.pinFailed"));
      });
    },
    [setPinned, t, toast],
  );
  const searchLabel = search.textSearchEverywhere
    ? t("panels.notes.searchTitlesAndText")
    : t("panels.notes.searchTitles");

  if (isLoading && notes.length === 0) {
    return <StateView testID="notes-loading" title={t("common.states.loading")} />;
  }
  if (!supported && notes.length === 0) {
    return <StateView testID="notes-unsupported" title={t("panels.notes.hostTooOld")} />;
  }
  if (error && notes.length === 0) {
    return (
      <StateView
        testID="notes-error"
        title={t("panels.notes.loadFailed")}
        body={error.message}
        onRetry={refetch}
      />
    );
  }
  if (isLoading) {
    return <StateView testID="notes-loading" title={t("common.states.loading")} />;
  }
  if (notes.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.notice}>
          <HostErrorsNotice errors={hostErrors} />
        </View>
        <StateView
          testID={connectionStatus === "online" ? "notes-empty" : "notes-disconnected"}
          title={
            connectionStatus === "online"
              ? t("panels.notes.emptyTitle")
              : t("panels.notes.disconnected")
          }
          body={connectionStatus === "online" ? t("panels.notes.emptyDescription") : undefined}
        />
        <CreateNoteButton label={t("panels.notes.newNote")} onCreateNote={onCreateNote} />
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <View style={styles.notice}>
        <HostErrorsNotice errors={hostErrors} />
      </View>
      <View style={styles.toolbar}>
        <CreateNoteButton label={t("panels.notes.newNote")} onCreateNote={onCreateNote} />
      </View>
      <PanelSearchField
        testID="notes-search"
        label={searchLabel}
        onChangeText={setSearchQuery}
        archiveScope={archiveScopeControl}
      />
      {search.pending ? (
        <Text style={styles.searchStatus} testID="notes-search-status">
          {t("panels.notes.searchingText")}
        </Text>
      ) : null}
      {search.failed ? (
        <PanelSearchFailure
          testID="notes-search"
          message={t("panels.notes.searchFailed")}
          onRetry={search.retry}
        />
      ) : null}
      <NoteResults
        hasVisibleNotes={visibleNotes.length > 0}
        search={search}
        pinSupportedByServerId={pinSupportedByServerId}
        archiveSupportedByServerId={archiveSupportedByServerId}
        onOpenNote={onOpenNote}
        onTogglePin={onTogglePin}
        onToggleArchive={onToggleArchive}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  list: {
    flex: 1,
  },
  toolbar: {
    alignItems: "flex-end",
    padding: theme.spacing[2],
  },
  notice: {
    padding: theme.spacing[2],
  },
  hostHeading: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  searchStatus: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    marginHorizontal: theme.spacing[3],
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
  rowTitleArchived: {
    color: theme.colors.mutedForeground,
  },
  rowMeta: {
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
  stateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  stateBody: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));
