import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import {
  formatTrackLabel,
  type PlayerSnapshot,
  playerCommandRpc,
  playerStateRpc,
} from "../shared/spotify";

/** Fast enough that a skip shows up before you wonder whether the click landed. */
const POLL_PLAYING_MS = 3_000;
/** Paused state only changes when someone acts, so back off. */
const POLL_PAUSED_MS = 10_000;
/** Spotify is closed or the host is not a Mac; stop spawning osascript every few seconds. */
const POLL_UNAVAILABLE_MS = 60_000;

const BUTTON_ID = "now-playing";

function pollDelay(snapshot: PlayerSnapshot): number {
  if (!snapshot.available) return POLL_UNAVAILABLE_MS;
  return snapshot.state === "playing" ? POLL_PLAYING_MS : POLL_PAUSED_MS;
}

function describe(snapshot: PlayerSnapshot): { title: string; icon: string; label: string } {
  const playing = snapshot.state === "playing";
  return {
    title: playing ? "Pause Spotify" : "Play Spotify",
    icon: playing ? "Pause" : "Play",
    label: formatTrackLabel(snapshot) ?? "Spotify",
  };
}

/**
 * Registers one header button per workspace and points every label at the same
 * snapshot. A button descriptor is not React, so the label is published
 * imperatively through `update()`. The sidebar surface runs its own query.
 */
export function startHeaderControls(client: PluginClientContext): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  let snapshot: PlayerSnapshot = { available: false, reason: "not_running" };

  function paint(): void {
    const presentation = { ...describe(snapshot), visible: snapshot.available };
    for (const button of buttons.values()) button.update(presentation);
  }

  function schedule(delay: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void poll(), delay);
  }

  async function poll(): Promise<void> {
    // Nothing is showing a label, so there is nothing to keep fresh.
    if (stopped || buttons.size === 0) return;
    try {
      snapshot = await client.rpc(playerStateRpc, {});
    } catch {
      // An offline or reloading host is not worth a toast on a background poll.
      snapshot = { available: false, reason: "error" };
    }
    if (stopped) return;
    paint();
    schedule(pollDelay(snapshot));
  }

  async function toggle(): Promise<void> {
    snapshot = await client.rpc(playerCommandRpc, { action: "playpause" });
    if (stopped) return;
    paint();
    schedule(pollDelay(snapshot));
  }

  function register(workspaceId: string): void {
    if (stopped || buttons.has(workspaceId)) return;
    buttons.set(
      workspaceId,
      client.addHeaderButton({
        id: BUTTON_ID,
        workspaceId,
        button: {
          ...describe(snapshot),
          visible: snapshot.available,
          behavior: { kind: "action", onPress: toggle },
        },
      }),
    );
    if (buttons.size === 1) void poll();
  }

  function forget(workspaceId: string): void {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  }

  function replaceAll(workspaces: readonly { readonly id: string }[]): void {
    const live = new Set(workspaces.map((workspace) => workspace.id));
    for (const workspaceId of Array.from(buttons.keys())) {
      if (!live.has(workspaceId)) forget(workspaceId);
    }
    for (const workspaceId of live) register(workspaceId);
  }

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ entries, subscription }) => {
      if (stopped) {
        void subscription.release();
        return undefined;
      }
      replaceAll(entries);
      release = () => subscription.release();
      unsubscribe = subscription.subscribe({
        // A reconnect replays the whole directory; rebuild rather than merge.
        snapshot: ({ entries: current }) => replaceAll(current),
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "remove") forget(update.id);
          else register(update.workspace.id);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) console.error("Spotify header controls failed to observe workspaces", error);
    });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    void release?.();
    for (const button of buttons.values()) button.remove();
    buttons.clear();
  };
}
