import { expect, type Page } from "@playwright/test";

import { daemonWsRoutePattern } from "./daemon-port";
import { ensureExplorerSidebar } from "./workspace-tabs";

export const ARTIFACT_HTML = "<h1 id='heading'>Q3 revenue</h1>";

// Encoded here rather than imported from @getpaseo/protocol on purpose. Every other e2e helper
// takes the protocol as `import type`, so this would be the suite's first value import from it,
// and Playwright's loader then resolves the package differently from the plain-ESM dynamic
// import the seed client uses — the two instances collide before any test runs. Spelling the
// three opcodes out also makes the spec an independent check of the wire format.
const OPCODE = { fileBegin: 0x10, fileChunk: 0x11, fileEnd: 0x12 } as const;

function encodeFrame(input: {
  opcode: number;
  requestId: string;
  metadata?: unknown;
  payload?: Uint8Array;
}): Buffer {
  const requestId = new TextEncoder().encode(input.requestId);
  const head = Buffer.from([input.opcode, requestId.byteLength]);
  if (input.opcode === OPCODE.fileBegin) {
    const metadata = new TextEncoder().encode(JSON.stringify(input.metadata));
    const length = Buffer.alloc(2);
    length.writeUInt16BE(metadata.byteLength);
    return Buffer.concat([head, requestId, length, metadata]);
  }
  return Buffer.concat([head, requestId, input.payload ?? new Uint8Array()]);
}
export const OWNED_ID = "art_0000000000000001";
export const LINKED_ID = "art_0000000000000002";
export const LINK_ONLY_ID = "art_0000000000000003";
export const LINK_ONLY_URL = "https://claude.ai/code/artifact/link-only";

function artifactRecord(input: {
  artifactId: string;
  title: string;
  /** Null for an artifact the daemon does not store — a title pointing at externalUrl. */
  size: number | null;
  externalUrl: string | null;
}) {
  return {
    artifactId: input.artifactId,
    projectId: "prj_stub",
    title: input.title,
    mimeType: "text/html",
    size: input.size,
    contentSha256: input.size === null ? null : "a".repeat(64),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    pinned: false,
    externalUrl: input.externalUrl,
    origin: { agentId: "agt_stub", workspaceId: "wks_stub", provider: "claude" },
  };
}

/**
 * Answers the artifact RPCs in front of the real daemon, and proxies everything else.
 *
 * Publishing is deliberately agent-only, so there is no user-facing way to put an artifact in
 * the store. Stubbing the two read RPCs exercises the whole client path that matters here —
 * list, the binary download and its ack pacing, then the sandboxed render — against the real
 * app and the real daemon connection.
 */
export async function stubArtifactRpcs(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      if (typeof message !== "string") {
        serverSocket.send(message);
        return;
      }
      const envelope = JSON.parse(message) as {
        message?: { type?: string; projectId?: string; artifactId?: string; requestId?: string };
      };
      const inbound = envelope.message;

      if (inbound?.type === "artifact.list.request") {
        browserSocket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "artifact.list.response",
              payload: {
                projectId: inbound.projectId,
                artifacts: [
                  artifactRecord({
                    artifactId: LINKED_ID,
                    title: "Migration risk report",
                    size: 184_320,
                    externalUrl: "https://claude.ai/public/artifacts/abc",
                  }),
                  artifactRecord({
                    artifactId: OWNED_ID,
                    title: "Q3 revenue dashboard",
                    size: ARTIFACT_HTML.length,
                    externalUrl: null,
                  }),
                  artifactRecord({
                    artifactId: LINK_ONLY_ID,
                    title: "Published on claude.ai",
                    size: null,
                    externalUrl: LINK_ONLY_URL,
                  }),
                ],
                success: true,
                error: null,
                requestId: inbound.requestId,
              },
            },
          }),
        );
        return;
      }

      if (inbound?.type === "artifact.entry.download.request") {
        const requestId = inbound.requestId ?? "";
        const bytes = new TextEncoder().encode(ARTIFACT_HTML);
        browserSocket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "artifact.entry.download.response",
              payload: {
                artifactId: inbound.artifactId,
                title: "Q3 revenue dashboard",
                mimeType: "text/html",
                size: bytes.byteLength,
                success: true,
                error: null,
                requestId,
              },
            },
          }),
        );
        browserSocket.send(
          encodeFrame({
            opcode: OPCODE.fileBegin,
            requestId,
            metadata: {
              mime: "text/html",
              size: bytes.byteLength,
              encoding: "utf-8",
              modifiedAt: "2026-09-01T00:00:00.000Z",
            },
          }),
        );
        browserSocket.send(encodeFrame({ opcode: OPCODE.fileChunk, requestId, payload: bytes }));
        browserSocket.send(encodeFrame({ opcode: OPCODE.fileEnd, requestId }));
        return;
      }

      if (inbound?.type === "fs.transfer.ack" || inbound?.type === "fs.transfer.cancel") {
        // The transfer above was answered here, so its flow control belongs here too. Passing
        // it through would ack a requestId the daemon never issued.
        return;
      }

      serverSocket.send(message);
    });
    serverSocket.onMessage((message) => browserSocket.send(message));
  });
}

/**
 * Artifacts is absent from the main pane's `+` menu by manifest: `supportedHosts` is
 * `["explorer"]`, and the launcher filters on it. On desktop the Explorer's singleton views are
 * toggled from its tab rail's context menu, which lists exactly the launch items that do not
 * support the main host.
 */
export async function openArtifactsPanel(page: Page): Promise<void> {
  await ensureExplorerSidebar(page);
  const rail = page.getByTestId("explorer-sidebar-tab-rail").first();
  const box = await rail.boundingBox();
  if (!box) throw new Error("Explorer tab rail has no bounding box");
  // Past the tab chips: each is its own context-menu trigger and stops propagation, so a click
  // in the middle of the rail opens that tab's menu instead of the rail's.
  await rail.click({ button: "right", position: { x: box.width - 8, y: box.height / 2 } });
  const menu = page.getByTestId("explorer-sidebar-tab-configuration");
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.getByText("Artifacts", { exact: true }).click();
}
