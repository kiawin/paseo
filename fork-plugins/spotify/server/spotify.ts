import type { RpcInput } from "@getpaseo/plugin";
import {
  FIELD_SEPARATOR,
  type PlayerAction,
  type PlayerSnapshot,
  type playerCommandRpc,
} from "../shared/spotify";
import { runAppleScript } from "./applescript";

const BUNDLE_ID = "com.spotify.client";

/**
 * Addressing by bundle id rather than name matters: `tell application "Spotify"`
 * on a Mac without Spotify opens a "Where is Spotify?" file chooser and blocks
 * the daemon until someone dismisses it.
 *
 * Reading `running` is also the only safe probe. Any other property access
 * launches Spotify, which would start a music player every poll.
 */
const GUARD = `try
	if not (running of application id "${BUNDLE_ID}") then return "STATUS:not_running"
on error
	return "STATUS:no_spotify"
end try`;

const READ_SCRIPT = `${GUARD}
tell application id "${BUNDLE_ID}"
	set playerStateText to (player state as text)
	if playerStateText is "stopped" then return "STATUS:stopped"
	set trackName to ""
	set trackArtist to ""
	set trackAlbum to ""
	set trackArtwork to ""
	set positionMs to 0
	set durationMs to 0
	try
		set trackName to name of current track
		set trackArtist to artist of current track
		set trackAlbum to album of current track
		set durationMs to (duration of current track)
		set positionMs to (round (player position * 1000))
		try
			set trackArtwork to artwork url of current track
		end try
	on error
		return "STATUS:stopped"
	end try
	return playerStateText & "${FIELD_SEPARATOR}" & trackName & "${FIELD_SEPARATOR}" & trackArtist & "${FIELD_SEPARATOR}" & trackAlbum & "${FIELD_SEPARATOR}" & trackArtwork & "${FIELD_SEPARATOR}" & (positionMs as text) & "${FIELD_SEPARATOR}" & (durationMs as text)
end tell`;

/**
 * Fixed verbs only. The action arrives validated against a Zod enum and indexes
 * this record, so no caller-supplied text ever reaches AppleScript source.
 */
const COMMAND_VERBS: Record<PlayerAction, string> = {
  playpause: "playpause",
  next: "next track",
  previous: "previous track",
};

/** Spotify reports the outgoing track for a moment after a skip. */
const TRACK_CHANGE_SETTLE_MS = 180;

const UNAVAILABLE: Record<string, PlayerSnapshot> = {
  not_running: { available: false, reason: "not_running" },
  no_spotify: { available: false, reason: "no_spotify" },
  stopped: { available: true, state: "stopped" },
};

function toPositiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseSnapshot(raw: string): PlayerSnapshot {
  const trimmed = raw.trim();
  if (trimmed.startsWith("STATUS:")) {
    return UNAVAILABLE[trimmed.slice("STATUS:".length)] ?? { available: false, reason: "error" };
  }
  const fields = trimmed.split(FIELD_SEPARATOR);
  if (fields.length !== 7) {
    return { available: false, reason: "error", message: "Unrecognized AppleScript output" };
  }
  const [state, track, artist, album, artworkUrl, positionMs, durationMs] = fields;
  return {
    available: true,
    state: state === "playing" || state === "paused" ? state : "stopped",
    track: track || undefined,
    artist: artist || undefined,
    album: album || undefined,
    artworkUrl: artworkUrl || undefined,
    positionMs: toPositiveInteger(positionMs),
    durationMs: toPositiveInteger(durationMs),
  };
}

export async function readPlayerState(): Promise<PlayerSnapshot> {
  if (process.platform !== "darwin") return { available: false, reason: "not_macos" };
  const outcome = await runAppleScript(READ_SCRIPT);
  if (!outcome.ok) {
    return {
      available: false,
      reason: outcome.denied ? "denied" : "error",
      message: outcome.message,
    };
  }
  return parseSnapshot(outcome.stdout);
}

export async function runPlayerCommand({
  action,
}: RpcInput<typeof playerCommandRpc>): Promise<PlayerSnapshot> {
  if (process.platform !== "darwin") return { available: false, reason: "not_macos" };
  const outcome = await runAppleScript(`${GUARD}
tell application id "${BUNDLE_ID}" to ${COMMAND_VERBS[action]}
return "STATUS:ok"`);
  if (!outcome.ok) {
    return {
      available: false,
      reason: outcome.denied ? "denied" : "error",
      message: outcome.message,
    };
  }
  const guardResult = outcome.stdout.trim();
  if (guardResult !== "STATUS:ok") return parseSnapshot(guardResult);
  if (action !== "playpause") {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), TRACK_CHANGE_SETTLE_MS);
    });
  }
  return readPlayerState();
}
