import type { IpcMainInvokeEvent } from "electron";
import type { createRecordingBridge } from "./ipc.js";

type Bridge = Pick<
  ReturnType<typeof createRecordingBridge>,
  "active" | "start" | "stop" | "list" | "listMedia" | "readEvents" | "readMedia" | "delete"
>;
interface Registry {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, input: unknown) => unknown): void;
  removeHandler(channel: string): void;
}
export function isTrustedRecordingUrl(
  value: string,
  packaged: boolean,
  devServerUrl: string,
): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (packaged) return url.protocol === "paseo:" && url.hostname === "app" && !url.port;
    const expected = new URL(devServerUrl);
    return (
      url.origin === expected.origin && (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
}
export function registerRecordingIpc(ipc: Registry, bridge: Bridge): () => void {
  const caller = (event: IpcMainInvokeEvent) => ({
    senderId: event.sender.id,
    mainFrame: event.senderFrame === event.sender.mainFrame,
    url: event.senderFrame?.url ?? "",
  });
  const handlers = {
    "paseo:recording:start": bridge.start,
    "paseo:recording:active": bridge.active,
    "paseo:recording:stop": bridge.stop,
    "paseo:recording:list": bridge.list,
    "paseo:recording:list-media": bridge.listMedia,
    "paseo:recording:read-events": bridge.readEvents,
    "paseo:recording:read-media": bridge.readMedia,
    "paseo:recording:delete": bridge.delete,
  };
  for (const [channel, handler] of Object.entries(handlers))
    ipc.handle(channel, (event, input) => handler(caller(event), input));
  return () => {
    for (const channel of Object.keys(handlers)) ipc.removeHandler(channel);
  };
}
