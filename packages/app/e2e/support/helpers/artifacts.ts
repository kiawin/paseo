import { expect, type Page } from "@playwright/test";

import { daemonWsRoutePattern } from "./daemon-port";
import { openPullRequestResponse, STUB_PR_NUMBER } from "./pr-status-stub";
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
export const PR_NUMBER = STUB_PR_NUMBER;
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
export async function stubArtifactRpcs(
  page: Page,
  options: { withOpenPullRequest?: boolean } = {},
): Promise<void> {
  const deletedArtifactIds = new Set<string>();
  let listedProjectId = "prj_stub";

  // One handler for the whole socket: Playwright routes a pattern to a single handler, so a
  // second `routeWebSocket` call would replace this one rather than compose with it.
  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      if (typeof message !== "string") {
        serverSocket.send(message);
        return;
      }
      const envelope = JSON.parse(message) as {
        message?: {
          type?: string;
          projectId?: string;
          artifactId?: string;
          cwd?: string;
          requestId?: string;
        };
      };
      const inbound = envelope.message;

      if (options.withOpenPullRequest && inbound?.type === "checkout_pr_status_request") {
        browserSocket.send(JSON.stringify(openPullRequestResponse(inbound)));
        return;
      }

      if (inbound?.type === "artifact.list.request") {
        listedProjectId = inbound.projectId ?? listedProjectId;
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
                ].filter((artifact) => !deletedArtifactIds.has(artifact.artifactId)),
                success: true,
                error: null,
                requestId: inbound.requestId,
              },
            },
          }),
        );
        return;
      }

      if (inbound?.type === "artifact.delete.request") {
        deletedArtifactIds.add(inbound.artifactId ?? "");
        browserSocket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "artifact.delete.response",
              payload: {
                artifactId: inbound.artifactId,
                success: true,
                error: null,
                requestId: inbound.requestId,
              },
            },
          }),
        );
        browserSocket.send(
          JSON.stringify({
            type: "session",
            message: { type: "artifact.changed", payload: { projectId: listedProjectId } },
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
    serverSocket.onMessage((message) => {
      if (options.withOpenPullRequest && typeof message === "string") {
        const envelope = JSON.parse(message) as {
          message?: {
            type?: string;
            payload?: {
              cwd?: string;
              prStatus?: { requestId?: string };
            };
          };
        };
        const payload = envelope.message?.payload;
        if (envelope.message?.type === "checkout_status_update" && payload?.prStatus) {
          const stubbed = openPullRequestResponse({
            cwd: payload.cwd,
            requestId: payload.prStatus.requestId,
          });
          browserSocket.send(
            JSON.stringify({
              ...envelope,
              message: {
                ...envelope.message,
                payload: { ...payload, prStatus: stubbed.message.payload },
              },
            }),
          );
          return;
        }
      }
      browserSocket.send(message);
    });
  });
}

/**
 * Artifacts is absent from the main pane's `+` menu by manifest: `supportedHosts` is
 * `["explorer"]`. The Explorer opens with its singleton views already tabbed, so normally this
 * only has to select that tab — and because the manifest marks the view `singleton`, the
 * `New tab` menu drops the entry for exactly as long as the tab exists. The launch path is the
 * fallback for a pane that has had the tab closed.
 */
export async function openArtifactsPanel(page: Page): Promise<void> {
  const explorer = await ensureExplorerSidebar(page);
  const artifactTab = explorer.getByTestId("workspace-tab-artifacts").first();
  if ((await artifactTab.count()) > 0) {
    await artifactTab.click();
    return;
  }

  await explorer.getByRole("button", { name: "New tab", exact: true }).click();
  const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await expect(menu).toHaveCSS("opacity", "1");
  // The entry carries its shortcut in the accessible name, as the other launch items do.
  await menu.getByRole("menuitem", { name: /^Artifacts/ }).click();
  await expect(menu).not.toBeVisible();
}

/**
 * Waits for the compact overlay's slide-in to settle.
 *
 * The panel animates in from the right, and `boundingBox()` reports the animated position — a
 * geometry assertion taken too early measures the transform, not the layout.
 */
export async function waitForCompactExplorerSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const header = document.querySelector('[data-testid="explorer-header"]');
      if (!header) return false;
      const x = Math.round(header.getBoundingClientRect().x);
      const state = window as unknown as { __explorerX?: number; __explorerStable?: number };
      state.__explorerStable = state.__explorerX === x ? (state.__explorerStable ?? 0) + 1 : 0;
      state.__explorerX = x;
      return (state.__explorerStable ?? 0) > 5;
    },
    undefined,
    { polling: 50, timeout: 15_000 },
  );
}
