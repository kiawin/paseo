import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Separator between fields in the AppleScript payload. AppleScript has no JSON,
 * and track titles routinely contain quotes, commas, pipes, and newlines, so the
 * script joins fields with a sentinel no real metadata carries.
 */
export const FIELD_SEPARATOR = "|~|";

export const PlayerStateSchema = z.enum(["playing", "paused", "stopped"]);

/**
 * Why a snapshot carries no track. The client turns each into different UI:
 * `denied` is the only one the user can act on.
 */
export const UnavailableReasonSchema = z.enum([
  /** Daemon host is not macOS. Spotify's AppleScript dictionary only exists there. */
  "not_macos",
  /** Spotify is installed but not running. Reading further would launch it. */
  "not_running",
  /** No app with bundle id com.spotify.client. */
  "no_spotify",
  /** macOS refused the Apple event. The host app needs Automation consent. */
  "denied",
  /** osascript failed some other way; `message` carries its stderr. */
  "error",
]);

export const PlayerSnapshotSchema = z.object({
  available: z.boolean(),
  reason: UnavailableReasonSchema.optional(),
  message: z.string().optional(),
  state: PlayerStateSchema.optional(),
  track: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  artworkUrl: z.string().optional(),
  positionMs: z.number().optional(),
  durationMs: z.number().optional(),
});

export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;

export const PlayerActionSchema = z.enum(["playpause", "next", "previous"]);

export type PlayerAction = z.infer<typeof PlayerActionSchema>;

export const playerStateRpc = defineRpc({
  name: "spotify.state",
  input: z.object({}),
  output: PlayerSnapshotSchema,
});

/**
 * Commands answer with the snapshot taken after the action, so a press repaints
 * without waiting for the next poll.
 */
export const playerCommandRpc = defineRpc({
  name: "spotify.command",
  input: z.object({ action: PlayerActionSchema }),
  output: PlayerSnapshotSchema,
});

export function formatTrackLabel(snapshot: PlayerSnapshot, maxLength = 38): string | undefined {
  if (!snapshot.track) return undefined;
  const full = snapshot.artist ? `${snapshot.track} — ${snapshot.artist}` : snapshot.track;
  return full.length > maxLength ? `${full.slice(0, maxLength - 1).trimEnd()}…` : full;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0)
    return "--:--";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
