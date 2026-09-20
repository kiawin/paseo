import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readPlayerState, runPlayerCommand } from "./server/spotify";
import { playerCommandRpc, playerStateRpc } from "./shared/spotify";

export default function contribute(server: PluginServerContext) {
  server.handle(playerStateRpc, () => readPlayerState());
  server.handle(playerCommandRpc, runPlayerCommand);
  return () => {};
}
