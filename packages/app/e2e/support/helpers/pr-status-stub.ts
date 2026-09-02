import type { Page } from "@playwright/test";

import { daemonWsRoutePattern } from "./daemon-port";

export const STUB_PR_NUMBER = 42;
export const STUB_PR_URL = `https://github.com/acme/repo/pull/${STUB_PR_NUMBER}`;
export const STUB_PR_TITLE = "Add the artifacts view";

/**
 * An open pull request for any checkout.
 *
 * The forge fixtures need real `gh` auth, which is why the specs using them are `.real`. Specs
 * that need a PR to exist but are not testing the forge integration answer the one status RPC
 * directly instead.
 */
export function openPullRequestResponse(inbound: { cwd?: string; requestId?: string }) {
  return {
    type: "session",
    message: {
      type: "checkout_pr_status_response",
      payload: {
        cwd: inbound.cwd,
        githubFeaturesEnabled: true,
        authState: "authenticated",
        forge: "github",
        error: null,
        requestId: inbound.requestId,
        status: {
          forge: "github",
          number: STUB_PR_NUMBER,
          url: STUB_PR_URL,
          title: STUB_PR_TITLE,
          // Lowercase, as the protocol and `derivePrState` both expect — "OPEN" renders Closed.
          state: "open",
          baseRefName: "main",
          headRefName: "feat/artifacts",
          isMerged: false,
          isDraft: false,
        },
      },
    },
  };
}

/**
 * Answers the PR status RPC in front of the real daemon and proxies everything else, so a
 * checkout with no forge remote still shows its pull request in the sidebar, the Changes
 * toolbar, and the PR pane.
 *
 * Two paths carry the status: the explicit request the pane makes, and the `prStatus` the
 * daemon folds into `checkout_status_update` for the sidebar. Both are rewritten here —
 * stubbing only the request leaves the sidebar's PR item absent.
 *
 * One handler owns the whole socket: Playwright routes a pattern to a single handler, so a
 * second `routeWebSocket` call replaces this one rather than composing with it.
 */
export async function stubOpenPullRequest(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      if (typeof message !== "string") {
        serverSocket.send(message);
        return;
      }
      const inbound = (
        JSON.parse(message) as { message?: { type?: string; cwd?: string; requestId?: string } }
      ).message;
      if (inbound?.type === "checkout_pr_status_request") {
        browserSocket.send(JSON.stringify(openPullRequestResponse(inbound)));
        return;
      }
      serverSocket.send(message);
    });
    serverSocket.onMessage((message) => {
      if (typeof message !== "string") {
        browserSocket.send(message);
        return;
      }
      const envelope = JSON.parse(message) as {
        message?: {
          type?: string;
          payload?: { cwd?: string; prStatus?: { requestId?: string } };
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
      browserSocket.send(message);
    });
  });
}
