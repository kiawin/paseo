import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { getDesktopHost, type DesktopRecordingMetadata } from "@/desktop/host";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  createRecordingShare,
  removeRecordingShare,
  type RecordingShareAudit,
  type RecordingShareDestination,
} from "@/attachments/recording-share";
import { prepareRecordingShare } from "@/attachments/recording-share-source";

function shortReasons(reasons: string[]): string {
  const shown = reasons.slice(0, 5).map((reason) => reason.slice(0, 200));
  return shown.join("; ");
}
function destination(serverId: string): RecordingShareDestination {
  const session = useSessionStore.getState().sessions[serverId];
  const client = session?.client;
  if (!client?.isConnected || client.getLastServerInfoMessage()?.features?.recordingShare !== true)
    throw new Error("recording-share-host-unavailable");
  return {
    begin: (input) => client.beginRecordingShare(input),
    upload: (shareId, segment) =>
      client.uploadRecordingShareSegment({
        shareId,
        segmentId: segment.id,
        size: segment.size,
        read: segment.read,
      }),
    complete: (shareId) => client.completeRecordingShare(shareId),
    delete: (shareId, agentId) => client.deleteRecordingShare(shareId, agentId),
  };
}
function AgentChoice({
  serverId,
  agentId,
  name,
  host,
  busy,
  start,
}: {
  serverId: string;
  agentId: string;
  name: string;
  host: string;
  busy: boolean;
  start: (serverId: string, agentId: string, name: string) => Promise<void>;
}) {
  const press = useCallback(() => {
    void start(serverId, agentId, name);
  }, [start, serverId, agentId, name]);
  return (
    <Button size="sm" disabled={busy} onPress={press}>
      {name} · {host}
    </Button>
  );
}
function SharedCopy({
  entry,
  busy,
  revoke,
  forget,
  agentName,
  hostName,
}: {
  entry: RecordingShareAudit;
  busy: boolean;
  agentName: string;
  hostName: string;
  revoke: (entry: RecordingShareAudit) => Promise<void>;
  forget: (entry: RecordingShareAudit) => Promise<void>;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => {
    void revoke(entry);
  }, [revoke, entry]);
  const forgetPress = useCallback(() => {
    void forget(entry);
  }, [forget, entry]);
  return (
    <View>
      <Text style={styles.text}>
        {t(entry.manifestPath ? "panels.recordings.sharedWith" : "panels.recordings.sharePending", {
          agent: agentName,
          host: hostName,
          time: new Date(entry.time).toLocaleString(),
        })}
      </Text>
      <Button size="sm" disabled={busy} onPress={press}>
        {t("panels.recordings.removeCopy")}
      </Button>
      <Button size="sm" disabled={busy} onPress={forgetPress}>
        {t("panels.recordings.forgetCopy")}
      </Button>
    </View>
  );
}
export function RecordingShare({ recording }: { recording: DesktopRecordingMetadata }) {
  const { t } = useTranslation();
  const sessions = useSessionStore((state) => state.sessions);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [audit, setAudit] = useState<RecordingShareAudit[]>([]);
  const [auditError, setAuditError] = useState(false);
  const showFailure = useCallback(
    (failure: unknown) => {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (message === "recording-share-host-unavailable")
        setError(t("panels.recordings.shareHostUnavailable"));
      else if (message === "recording-share-agent-unavailable")
        setError(t("panels.recordings.shareAgentUnavailable"));
      else setError(message);
    },
    [t],
  );
  const refresh = useCallback(async () => {
    const bridge = getDesktopHost()?.recording;
    if (!bridge) return;
    try {
      setAudit(await bridge.listShareAudit({ recordingId: recording.recordingId }));
      setAuditError(false);
    } catch (failure) {
      setAuditError(true);
      throw failure;
    }
  }, [recording.recordingId]);
  useEffect(() => {
    void refresh().catch((failure: unknown) => setError(String(failure)));
  }, [refresh]);
  const start = useCallback(
    async (serverId: string, agentId: string, agentName: string) => {
      const bridge = getDesktopHost()?.recording;
      if (!bridge || busy) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      const hostName = sessions[serverId]?.serverInfo?.hostname || serverId;
      try {
        const share = createRecordingShare({
          source: { prepare: () => prepareRecordingShare(bridge, recording) },
          resolveDestination: destination,
          confirm: ({ completeness }) =>
            confirmDialog({
              title: t("panels.recordings.shareTitle"),
              confirmLabel: t("panels.recordings.shareConfirm"),
              message: t("panels.recordings.shareWarning", {
                agent: agentName,
                host: hostName,
                completeness: completeness.complete
                  ? t("panels.recordings.shareComplete")
                  : t("panels.recordings.shareIncomplete", {
                      reasons: shortReasons(completeness.reasons),
                    }) +
                    (completeness.reasons.length > 5
                      ? ` ${t("panels.recordings.moreCaptureProblems", { extra: completeness.reasons.length - 5 })}`
                      : ""),
              }),
            }),
          reserve: (entry) => bridge.changeShareAudit({ recordingId: entry.recordingId, entry }),
          audit: (entry) => bridge.changeShareAudit({ recordingId: entry.recordingId, entry }),
          unreserve: (recordingId, shareId) =>
            bridge.changeShareAudit({ recordingId, removeShareId: shareId }),
          handoff: async ({ serverId: host, agentId: recipient, manifestPath, completeness }) => {
            const agent = useSessionStore.getState().sessions[host]?.agents.get(recipient);
            if (!agent || agent.archivedAt) throw new Error("recording-share-agent-unavailable");
            const { agentComposer } = await import("@/composer/agent-composer");
            agentComposer(host, recipient).insertText(
              `\nBrowser recording shared at ${manifestPath}. Read the manifest and recording.bin in the same directory. recording.bin describes files as ordered ranges with part ID, byte offset, and length; each part is stored as <part ID>.bin. Reconstruct each file by concatenating those ranges in order. Verify the hashes and sizes in the manifest before using the data. Capture ${completeness.complete ? "reported no gaps" : `is incomplete: ${shortReasons(completeness.reasons)}. See recording.bin for all capture issues`}.\n`,
            );
          },
          now: Date.now,
        });
        const shared = await share({
          recordingId: recording.recordingId,
          serverId,
          agentId,
          agentName,
        });
        setChoosing(false);
        if (shared) setNotice(t("panels.recordings.shareDone"));
      } catch (failure) {
        showFailure(failure);
      } finally {
        await refresh().catch((failure: unknown) => setError(String(failure)));
        setBusy(false);
      }
    },
    [busy, recording, refresh, sessions, showFailure, t],
  );
  const revoke = useCallback(
    async (entry: RecordingShareAudit) => {
      const bridge = getDesktopHost()?.recording;
      if (!bridge || busy) return;
      const confirmed = await confirmDialog({
        title: t("panels.recordings.removeCopy"),
        message: t("panels.recordings.removeCopyMessage", {
          agent: sessions[entry.serverId]?.agents.get(entry.agentId)?.title || entry.agentId,
          host: sessions[entry.serverId]?.serverInfo?.hostname || entry.serverId,
        }),
        confirmLabel: t("panels.recordings.remove"),
        destructive: true,
      });
      if (!confirmed) return;
      setBusy(true);
      setError(null);
      try {
        await removeRecordingShare(entry, destination, (recordingId, shareId) =>
          bridge.changeShareAudit({ recordingId, removeShareId: shareId }),
        );
        await refresh();
      } catch (failure) {
        showFailure(failure);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, sessions, showFailure, t],
  );
  const forget = useCallback(
    async (entry: RecordingShareAudit) => {
      const bridge = getDesktopHost()?.recording;
      if (!bridge || busy) return;
      const confirmed = await confirmDialog({
        title: t("panels.recordings.forgetCopy"),
        message: t("panels.recordings.forgetCopyMessage", {
          agent: sessions[entry.serverId]?.agents.get(entry.agentId)?.title || entry.agentId,
          host: sessions[entry.serverId]?.serverInfo?.hostname || entry.serverId,
        }),
        confirmLabel: t("panels.recordings.forgetCopy"),
        destructive: true,
      });
      if (!confirmed) return;
      setBusy(true);
      setError(null);
      try {
        await bridge.changeShareAudit({
          recordingId: entry.recordingId,
          removeShareId: entry.shareId,
        });
        await refresh();
      } catch (failure) {
        showFailure(failure);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, sessions, showFailure, t],
  );
  const forgetCorrupt = useCallback(async () => {
    const bridge = getDesktopHost()?.recording;
    if (!bridge || busy) return;
    const confirmed = await confirmDialog({
      title: t("panels.recordings.forgetCorruptAudit"),
      message: t("panels.recordings.forgetCorruptAuditMessage"),
      confirmLabel: t("panels.recordings.forgetCorruptAudit"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.forgetCorruptShareAudit({ recordingId: recording.recordingId });
      await refresh();
    } catch (failure) {
      showFailure(failure);
    } finally {
      setBusy(false);
    }
  }, [busy, recording.recordingId, refresh, showFailure, t]);
  const toggleChoosing = useCallback(() => setChoosing((current) => !current), []);
  return (
    <View style={styles.container}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.text}>{notice}</Text> : null}
      {auditError ? (
        <Button size="sm" disabled={busy} onPress={forgetCorrupt}>
          {t("panels.recordings.forgetCorruptAudit")}
        </Button>
      ) : null}
      <Button
        size="sm"
        disabled={busy || recording.status === "recording"}
        onPress={toggleChoosing}
      >
        {t("panels.recordings.share")}
      </Button>
      {choosing
        ? Object.values(sessions).flatMap((session) =>
            [...session.agents.values()]
              .filter((agent) => !agent.archivedAt && !agent.background)
              .map((agent) => (
                <AgentChoice
                  key={`${session.serverId}:${agent.id}`}
                  serverId={session.serverId}
                  agentId={agent.id}
                  name={agent.title || agent.id}
                  host={session.serverInfo?.hostname || session.serverId}
                  busy={busy}
                  start={start}
                />
              )),
          )
        : null}
      {audit.map((entry) => (
        <SharedCopy
          key={entry.shareId}
          entry={entry}
          busy={busy}
          revoke={revoke}
          forget={forget}
          agentName={sessions[entry.serverId]?.agents.get(entry.agentId)?.title || entry.agentId}
          hostName={sessions[entry.serverId]?.serverInfo?.hostname || entry.serverId}
        />
      ))}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { gap: 8 },
  text: { color: theme.colors.foregroundMuted },
  error: { color: theme.colors.destructive },
}));
