import { test, expect } from "vitest";
import type { SessionInboundMessage } from "../messages.js";
import { SessionDelivery } from "./owned-subscriptions/index.js";

const fileTransferRequests = [
  [
    "legacy file explorer",
    {
      type: "file_explorer_request",
      cwd: "/repo",
      path: "notes.txt",
      mode: "file",
      requestId: "legacy-file",
    },
  ],
  [
    "workspace entry download",
    {
      type: "fs.entry.download.request",
      cwd: "/repo",
      path: "notes.txt",
      requestId: "workspace-file",
    },
  ],
] as const satisfies ReadonlyArray<readonly [string, SessionInboundMessage]>;

test.each(fileTransferRequests)("authorizes %s binary replies", async (_label, request) => {
  const socket = {};
  const delivery = new SessionDelivery(() => {});
  delivery.attach(socket, true);
  let permitted = false;

  await delivery.request(socket, request, async () => {
    const frame = new Uint8Array([0x10]);
    delivery.authorizeFileReply(frame, socket);
    permitted = delivery.permitsBinary(socket, frame);
  });

  expect(permitted).toBe(true);
});
