import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Image, Pressable, Text, View } from "react-native";
import {
  formatDuration,
  type PlayerAction,
  type PlayerSnapshot,
  playerCommandRpc,
  playerStateRpc,
} from "../shared/spotify";

const QUERY_KEY = ["spotify", "state"] as const;
const REFETCH_PLAYING_MS = 1_000;
const REFETCH_IDLE_MS = 5_000;
const REFETCH_UNAVAILABLE_MS = 30_000;

const UNAVAILABLE_COPY: Record<string, { title: string; detail: string }> = {
  not_macos: {
    title: "Not a Mac",
    detail:
      "This host drives Spotify through AppleScript, which only exists on macOS. Install the plugin on the daemon running on your Mac.",
  },
  not_running: {
    title: "Spotify is not running",
    detail: "Open Spotify on the daemon's Mac. Paseo never launches it for you.",
  },
  no_spotify: {
    title: "Spotify is not installed",
    detail: "No application with bundle id com.spotify.client on the daemon's Mac.",
  },
  denied: {
    title: "Automation access denied",
    detail:
      "macOS refused the Apple event. Allow Paseo to control Spotify under System Settings → Privacy & Security → Automation, then try again.",
  },
  error: {
    title: "Could not reach Spotify",
    detail: "The daemon ran osascript but it failed.",
  },
};

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: compact ? 16 : 24,
        gap: compact ? 16 : 20,
        backgroundColor: theme.colors.surface0,
      },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 16 },
      artwork: {
        width: compact ? 72 : 96,
        height: compact ? 72 : 96,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      identity: { flex: 1, gap: 4 },
      track: {
        color: theme.colors.foreground,
        fontSize: compact ? 18 : 22,
        fontWeight: "600" as const,
      },
      artist: { color: theme.colors.foregroundMuted, fontSize: compact ? 14 : 15 },
      album: { color: theme.colors.foregroundMuted, fontSize: 13 },
      progressTrack: {
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden" as const,
      },
      progressFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.accent },
      times: { flexDirection: "row" as const, justifyContent: "space-between" as const },
      time: { color: theme.colors.foregroundMuted, fontSize: 12 },
      transport: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 12,
      },
      control: {
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      controlText: { color: theme.colors.foreground, fontSize: 15 },
      primaryControl: {
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
        borderWidth: 1,
        borderColor: theme.colors.accent,
      },
      primaryText: {
        color: theme.colors.accentForeground,
        fontSize: 15,
        fontWeight: "600" as const,
      },
      notice: { gap: 8 },
      noticeTitle: { color: theme.colors.foreground, fontSize: compact ? 17 : 19 },
      noticeDetail: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme, compact],
  );
}

type Styles = ReturnType<typeof useStyles>;

function refetchInterval(snapshot: PlayerSnapshot | undefined): number {
  if (!snapshot?.available) return REFETCH_UNAVAILABLE_MS;
  return snapshot.state === "playing" ? REFETCH_PLAYING_MS : REFETCH_IDLE_MS;
}

function UnavailableNotice({ snapshot, styles }: { snapshot: PlayerSnapshot; styles: Styles }) {
  const copy = UNAVAILABLE_COPY[snapshot.reason ?? "error"] ?? UNAVAILABLE_COPY.error;
  return (
    <View style={styles.screen}>
      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>{copy.title}</Text>
        <Text style={styles.noticeDetail}>{copy.detail}</Text>
        {snapshot.message ? <Text style={styles.error}>{snapshot.message}</Text> : null}
      </View>
    </View>
  );
}

function NowPlaying({
  snapshot,
  pending,
  styles,
}: {
  snapshot: PlayerSnapshot | undefined;
  pending: boolean;
  styles: Styles;
}) {
  const artworkUrl = snapshot?.artworkUrl;
  const artworkSource = useMemo(() => (artworkUrl ? { uri: artworkUrl } : undefined), [artworkUrl]);
  return (
    <View style={styles.header}>
      {artworkSource ? (
        <Image accessibilityIgnoresInvertColors source={artworkSource} style={styles.artwork} />
      ) : (
        <View style={styles.artwork} />
      )}
      <View style={styles.identity}>
        <Text numberOfLines={2} style={styles.track}>
          {snapshot?.track ?? (pending ? "Reading Spotify…" : "Nothing playing")}
        </Text>
        {snapshot?.artist ? (
          <Text numberOfLines={1} style={styles.artist}>
            {snapshot.artist}
          </Text>
        ) : null}
        {snapshot?.album ? (
          <Text numberOfLines={1} style={styles.album}>
            {snapshot.album}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Progress({ snapshot, styles }: { snapshot: PlayerSnapshot | undefined; styles: Styles }) {
  const positionMs = snapshot?.positionMs ?? 0;
  const durationMs = snapshot?.durationMs ?? 0;
  const percent = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;
  const fill = useMemo(
    () => [styles.progressFill, { width: `${percent}%` as const }],
    [styles, percent],
  );
  return (
    <View>
      <View style={styles.progressTrack}>
        <View style={fill} />
      </View>
      <View style={styles.times}>
        <Text style={styles.time}>{formatDuration(positionMs)}</Text>
        <Text style={styles.time}>{formatDuration(durationMs)}</Text>
      </View>
    </View>
  );
}

export function SpotifySurface({ theme, layout }: PluginSurfaceProps) {
  const styles = useStyles(theme, layout.compact);
  const queryClient = useQueryClient();
  const readState = useRpc(playerStateRpc);
  const sendCommand = useRpc(playerCommandRpc);

  const state = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => readState({}),
    refetchInterval: (query) => refetchInterval(query.state.data),
  });

  const command = useMutation({
    mutationFn: (action: PlayerAction) => sendCommand({ action }),
    // The command answers with the post-action snapshot, so seed the cache with
    // it instead of waiting out the poll interval.
    onSuccess: (snapshot) => queryClient.setQueryData(QUERY_KEY, snapshot),
  });

  const { mutate } = command;
  const previous = useCallback(() => mutate("previous"), [mutate]);
  const toggle = useCallback(() => mutate("playpause"), [mutate]);
  const next = useCallback(() => mutate("next"), [mutate]);

  const snapshot = state.data;
  if (snapshot && !snapshot.available) {
    return <UnavailableNotice snapshot={snapshot} styles={styles} />;
  }
  const playing = snapshot?.state === "playing";

  return (
    <View style={styles.screen}>
      <NowPlaying pending={state.isPending} snapshot={snapshot} styles={styles} />
      <Progress snapshot={snapshot} styles={styles} />
      <View style={styles.transport}>
        <Pressable
          accessibilityLabel="Previous track"
          accessibilityRole="button"
          disabled={command.isPending}
          onPress={previous}
          style={styles.control}
        >
          <Text style={styles.controlText}>Previous</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={playing ? "Pause" : "Play"}
          accessibilityRole="button"
          disabled={command.isPending}
          onPress={toggle}
          style={styles.primaryControl}
        >
          <Text style={styles.primaryText}>{playing ? "Pause" : "Play"}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Next track"
          accessibilityRole="button"
          disabled={command.isPending}
          onPress={next}
          style={styles.control}
        >
          <Text style={styles.controlText}>Next</Text>
        </Pressable>
      </View>
      {command.error ? <Text style={styles.error}>{command.error.message}</Text> : null}
    </View>
  );
}
