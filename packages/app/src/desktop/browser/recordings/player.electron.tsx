import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { isWeb } from "@/constants/platform";
import { createPlayback, readVerifiedSegment } from "./playback";
import type { RecordingPlayerProps } from "./player";

function waitForUpdate(buffer: SourceBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Video buffer failed"));
    };
    const cleanup = () => {
      buffer.removeEventListener("updateend", done);
      buffer.removeEventListener("error", failed);
    };
    buffer.addEventListener("updateend", done, { once: true });
    buffer.addEventListener("error", failed, { once: true });
  });
}
function openMediaSource(source: MediaSource): Promise<void> {
  return new Promise((resolve, reject) => {
    source.addEventListener("sourceopen", () => resolve(), { once: true });
    source.addEventListener("sourceclose", () => reject(new Error("Video source closed")), {
      once: true,
    });
  });
}
export function RecordingPlayer({
  recordingId,
  segments,
  hasMore,
  seek,
  pending,
  durationMs,
}: RecordingPlayerProps) {
  const { t } = useTranslation();
  const unsupportedMessage = t("panels.recordings.videoUnsupported");
  const playback = useMemo(() => createPlayback(segments), [segments]);
  const views = playback.views();
  const [selected, setSelected] = useState<string | null>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [heldGeneration, setHeldGeneration] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const desired = useRef(0);
  const pendingSeek = useRef(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const duration = segments.reduce(
    (end, segment) => Math.max(end, segment.startMs + segment.durationMs),
    Math.max(0, durationMs ?? 0),
  );
  playback.select(selected ?? views[0] ?? "");
  playback.seek(timeMs);
  const current = playback.getState();
  const generation = current.generation;
  const activeView = selected ?? views[0] ?? "";
  const ranges = playback.ranges(activeView, duration);
  desired.current = timeMs;
  useEffect(() => {
    if (selected !== null || !segments.length || seek) return;
    const first = [...segments].sort((a, b) => a.startMs - b.startMs)[0];
    setSelected(first.streamId);
    setTimeMs(first.startMs);
  }, [selected, segments, seek]);
  const seekAction = useRef<(time: number, stream?: string) => void>(() => {});
  seekAction.current = (time, stream) => {
    setHeldGeneration(null);
    const nextTime = Math.max(0, Math.min(duration, time));
    const nextView = stream ?? activeView;
    playback.select(nextView);
    playback.seek(nextTime);
    const nextGeneration = playback.getState().generation;
    const same =
      nextView === activeView &&
      generation?.generationId === nextGeneration?.generationId &&
      nextGeneration !== null;
    const element = video.current;
    const localTime = nextGeneration ? (nextTime - nextGeneration.startMs) / 1000 : 0;
    const buffered =
      same &&
      element &&
      Array.from({ length: element.buffered.length }, (_, index) => index).some(
        (index) =>
          localTime >= element.buffered.start(index) && localTime < element.buffered.end(index),
      );
    if (buffered && element) {
      element.currentTime = localTime;
      pendingSeek.current = false;
    } else {
      pendingSeek.current = Boolean(nextGeneration);
      if (same) setReload((value) => value + 1);
    }
    if (stream) setSelected(stream);
    desired.current = nextTime;
    setTimeMs(nextTime);
  };
  useEffect(() => {
    if (seek) seekAction.current(seek.timeMs, seek.streamId);
  }, [seek]);
  useEffect(() => {
    if (
      !playing ||
      (generation && heldGeneration !== generation.generationId) ||
      hasMore ||
      (error && generation)
    )
      return;
    pendingSeek.current = false;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const elapsed = Math.max(0, now - previous);
      previous = now;
      setTimeMs((time) => Math.min(duration, time + elapsed));
    }, 50);
    return () => clearInterval(timer);
  }, [playing, generation, heldGeneration, hasMore, error, duration]);
  useEffect(() => {
    if (playing && timeMs >= duration) setPlaying(false);
  }, [playing, timeMs, duration]);
  useEffect(() => {
    const element = video.current;
    if (
      !element ||
      !generation ||
      heldGeneration === generation.generationId ||
      pendingSeek.current ||
      element.readyState < 2
    )
      return;
    if (playing)
      void element.play().catch((cause: unknown) => {
        if (!(cause instanceof DOMException) || cause.name !== "AbortError")
          setError(String(cause));
      });
    else element.pause();
  }, [playing, generation, heldGeneration]);
  const onTimeUpdate = useCallback(() => {
    if (
      !video.current ||
      !generation ||
      video.current.seeking ||
      video.current.ended ||
      pendingSeek.current
    )
      return;
    setTimeMs(generation.startMs + video.current.currentTime * 1000);
  }, [generation]);
  const onCanPlay = useCallback(() => {
    const element = video.current;
    if (
      !element ||
      !playingRef.current ||
      pendingSeek.current ||
      heldGeneration === generation?.generationId ||
      !element.paused
    )
      return;
    void element.play().catch((cause: unknown) => {
      if (!(cause instanceof DOMException) || cause.name !== "AbortError") setError(String(cause));
    });
  }, [generation, heldGeneration]);
  const onEnded = useCallback(() => {
    if (generation && video.current?.ended && !pendingSeek.current)
      setHeldGeneration(generation.generationId);
  }, [generation]);
  const onScrub = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => seekAction.current(Number(event.currentTarget.value)),
    [],
  );
  const togglePlaying = useCallback(() => {
    if (timeMs >= duration) seekAction.current(0);
    else if (!playing && generation && video.current?.ended)
      setHeldGeneration(generation.generationId);
    setPlaying((value) => !value);
  }, [duration, generation, playing, timeMs]);
  const toggleMuted = useCallback(() => setMuted((value) => !value), []);
  const selectView = useCallback((id: string) => setSelected(id), []);
  useEffect(() => {
    const element = video.current;
    const bridge = getDesktopHost()?.recording;
    if (!isWeb || !element || !bridge || !generation || hasMore) return;
    const abort = new AbortController();
    const media = new MediaSource();
    const url = URL.createObjectURL(media);
    element.src = url;
    pendingSeek.current = true;
    setError(null);
    void (async () => {
      await openMediaSource(media);
      if (abort.signal.aborted) return;
      const mime = generation.segments[0].mimeType;
      if (!MediaSource.isTypeSupported(mime)) throw new Error(unsupportedMessage);
      const buffer = media.addSourceBuffer(mime);
      for (const segment of generation.segments) {
        while (
          !abort.signal.aborted &&
          !pendingSeek.current &&
          segment.startMs >
            Math.max(desired.current, generation.startMs + (element.currentTime + 20) * 1000)
        )
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        if (abort.signal.aborted) return;
        await readVerifiedSegment(
          bridge,
          recordingId,
          segment,
          async (chunk) => {
            if (abort.signal.aborted) return;
            const trim = async () => {
              const keepAfter = Math.max(0, (desired.current - generation.startMs) / 1000 - 15);
              if (!buffer.buffered.length || keepAfter <= buffer.buffered.start(0)) return false;
              buffer.remove(0, keepAfter);
              await waitForUpdate(buffer);
              return true;
            };
            await trim();
            try {
              buffer.appendBuffer(new Uint8Array(chunk));
            } catch (cause) {
              if (
                !(cause instanceof DOMException) ||
                cause.name !== "QuotaExceededError" ||
                !(await trim())
              )
                throw cause;
              buffer.appendBuffer(new Uint8Array(chunk));
            }
            await waitForUpdate(buffer);
          },
          undefined,
          abort.signal,
        );
        const relativeSeconds = Math.max(0, (desired.current - generation.startMs) / 1000);
        // A clock tick can enter a new generation a few milliseconds late.
        // Seek its first frame exactly, rather than skipping a sparse first frame.
        const desiredSeconds = relativeSeconds < 0.1 ? 0 : relativeSeconds;
        if (
          buffer.buffered.length &&
          desiredSeconds > 30 &&
          buffer.buffered.start(0) < desiredSeconds - 15
        ) {
          const updateDone = waitForUpdate(buffer);
          buffer.remove(0, desiredSeconds - 15);
          await updateDone;
        }
        const buffered = Array.from({ length: buffer.buffered.length }, (_, index) => index).some(
          (index) =>
            desiredSeconds >= buffer.buffered.start(index) &&
            desiredSeconds < buffer.buffered.end(index),
        );
        if (pendingSeek.current && buffered) {
          try {
            if (Math.abs(element.currentTime - desiredSeconds) > 0.001)
              element.currentTime = desiredSeconds;
            pendingSeek.current = false;
            if (playingRef.current)
              void element.play().catch((cause: unknown) => {
                if (!(cause instanceof DOMException) || cause.name !== "AbortError")
                  setError(String(cause));
              });
          } catch {
            /* Seek after more data arrives. */
          }
        }
      }
      if (!abort.signal.aborted && media.readyState === "open") media.endOfStream();
    })().catch((cause: unknown) => {
      if (!abort.signal.aborted) {
        element.pause();
        element.removeAttribute("src");
        element.load();
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => {
      abort.abort();
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
    };
  }, [recordingId, generation, hasMore, unsupportedMessage, reload]);
  const videoStyle = useMemo(
    () => ({
      width: "100%",
      display: current.available && !hasMore ? ("block" as const) : ("none" as const),
    }),
    [current.available, hasMore],
  );
  if (!views.length)
    return (
      <Text style={styles.muted}>
        {pending ? t("panels.recordings.mediaPending") : t("panels.recordings.noVideo")}
      </Text>
    );
  return (
    <View style={styles.container}>
      <View style={styles.views}>
        {views.map((id, index) => (
          <ViewButton
            key={id}
            id={id}
            label={`${t("panels.recordings.view")} ${index + 1}`}
            active={id === (selected ?? views[0])}
            select={selectView}
          />
        ))}
      </View>
      {hasMore ? <Text style={styles.muted}>{t("panels.recordings.loadMediaFirst")}</Text> : null}
      {selected && !views.includes(selected) ? (
        <Text style={styles.muted}>{t("panels.recordings.missingView")}</Text>
      ) : null}
      {!hasMore && !current.available ? (
        <Text style={styles.muted}>{t("panels.recordings.videoGap")}</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <video
        ref={video}
        muted={muted}
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onCanPlay={onCanPlay}
        style={videoStyle}
      />
      <View style={styles.track}>
        {ranges.map((range) => (
          <TimelineRange key={`${range.startMs}:${range.endMs}`} range={range} />
        ))}
      </View>
      <input
        type="range"
        aria-label={t("panels.recordings.timeline")}
        min={0}
        max={duration || 1}
        step={10}
        value={Math.min(duration, timeMs)}
        onChange={onScrub}
        disabled={hasMore}
      />
      <View style={styles.views}>
        <Button size="sm" onPress={togglePlaying} disabled={hasMore}>
          {playing ? t("panels.recordings.pause") : t("panels.recordings.play")}
        </Button>
        {segments.some((segment) => segment.track === "combined" || segment.track === "audio") ? (
          <Button size="sm" variant="ghost" onPress={toggleMuted}>
            {t(muted ? "panels.recordings.unmuteAudio" : "panels.recordings.muteAudio")}
          </Button>
        ) : null}
        <Text style={styles.muted}>
          {(timeMs / 1000).toFixed(1)}s / {(duration / 1000).toFixed(1)}s
        </Text>
      </View>
    </View>
  );
}
function TimelineRange({
  range,
}: {
  range: { startMs: number; endMs: number; available: boolean };
}) {
  const { t } = useTranslation();
  const style = useMemo(
    () => ({ flex: Math.max(0.001, range.endMs - range.startMs) }),
    [range.startMs, range.endMs],
  );
  return (
    <View
      accessibilityLabel={`${t(range.available ? "panels.recordings.videoAvailable" : "panels.recordings.videoGapLabel")} ${(range.startMs / 1000).toFixed(1)}–${(range.endMs / 1000).toFixed(1)}s`}
      style={[styles.trackPiece, range.available ? styles.trackAvailable : styles.trackGap, style]}
    />
  );
}
function ViewButton({
  id,
  label,
  active,
  select,
}: {
  id: string;
  label: string;
  active: boolean;
  select: (id: string) => void;
}) {
  const onPress = useCallback(() => select(id), [id, select]);
  return (
    <Button size="sm" variant={active ? "default" : "ghost"} onPress={onPress}>
      {label}
    </Button>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { gap: 8 },
  views: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  track: { flexDirection: "row", height: 5 },
  trackPiece: { height: 5 },
  trackAvailable: { backgroundColor: theme.colors.accent },
  trackGap: { backgroundColor: theme.colors.border },
  muted: { color: theme.colors.foregroundMuted },
  error: { color: theme.colors.destructive },
}));
