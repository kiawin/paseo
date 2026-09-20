import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startHeaderControls } from "./client/header";
import { SpotifySurface } from "./client/player";
import { type PlayerAction, playerCommandRpc } from "./shared/spotify";

const COMMANDS: readonly { id: string; action: PlayerAction; title: string; icon: string }[] = [
  { id: "playpause", action: "playpause", title: "Spotify: Play/Pause", icon: "Play" },
  { id: "next", action: "next", title: "Spotify: Next track", icon: "SkipForward" },
  { id: "previous", action: "previous", title: "Spotify: Previous track", icon: "SkipBack" },
];

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSurface("player", SpotifySurface),
    client.addSidebarItem({ id: "player", title: "Spotify", icon: "Music", surface: "player" }),
    ...COMMANDS.map(({ id, action, title, icon }) =>
      client.addCommandCenterItem({
        id,
        title,
        icon,
        keywords: ["music", "player", "spotify"],
        context: "global",
        async onSelect({ rpc }) {
          await rpc(playerCommandRpc, { action });
        },
      }),
    ),
    startHeaderControls(client),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
