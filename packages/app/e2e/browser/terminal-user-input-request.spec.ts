import { writeFile } from "node:fs/promises";

import type { TestInfo } from "@playwright/test";

import { expect, test, type Page } from "../support/fixtures";
import { submitMessage } from "../support/helpers/composer";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

// Spelled out rather than imported from the server package, matching the other mock-command
// specs. Source: MOCK_LOAD_TEST_REQUEST_TERMINAL_INPUT_COMMAND in mock-load-test-agent.ts.
const REQUEST_TERMINAL_INPUT_COMMAND = "/mock request-terminal-input";
const PASSWORD_PROMPT = "[sudo] password for e2e:";
const TERMINAL_NAME = "sudo: install deps";
const AGENT_TITLE = "fix-auth";
const SECRET = "correct-horse-battery";

// The tool catalog is what the agent opens the terminal through, and the worker daemon only
// injects it when asked.
test.use({ e2eInjectPaseoTools: true });

interface CapturedAttention {
  terminalId: string;
  reason: string;
  title: string;
  body: string;
}

/**
 * The provenance line only reaches the user through the OS notification, which a browser
 * recording cannot show. Reading the payload off the app's own WebSocket proves what the client
 * actually received.
 */
function captureSessionFrames(page: Page): {
  attention: CapturedAttention[];
  terminalSnapshots: unknown[];
} {
  const attention: CapturedAttention[] = [];
  const terminalSnapshots: unknown[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      if (typeof frame.payload !== "string") return;
      const isAttention = frame.payload.includes("terminal_attention_required");
      const isSnapshot = frame.payload.includes("terminals_changed");
      if (!isAttention && !isSnapshot) return;
      try {
        const parsed = JSON.parse(frame.payload) as {
          message?: { type?: string; payload?: unknown };
        };
        if (parsed.message?.type === "terminal_attention_required" && parsed.message.payload) {
          attention.push(parsed.message.payload as CapturedAttention);
        }
        if (parsed.message?.type === "terminals_changed" && parsed.message.payload) {
          terminalSnapshots.push(parsed.message.payload);
        }
      } catch {
        // Binary terminal stream frames are not notifications.
      }
    });
  });
  return { attention, terminalSnapshots };
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  const target = testInfo.outputPath(`${name}.json`);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await testInfo.attach(name, { path: target, contentType: "application/json" });
}

function readStatusBuckets(nodes: Element[]): Array<string | null> {
  return nodes.map((node) => node.getAttribute("data-status-bucket"));
}

/**
 * Terminal content lives in a canvas, so the daemon's own capture is the readable source. Polls
 * because the PTY write and the capture are not ordered against each other.
 */
async function waitForTerminalText(
  client: MockAgentWorkspace["client"],
  terminalId: string,
  needle: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastSeen = "";
  while (Date.now() < deadline) {
    const capture = await client.captureTerminal(terminalId, { stripAnsi: true });
    lastSeen = capture.lines.join("\n");
    if (lastSeen.includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in terminal:\n${lastSeen}`);
}

/**
 * The whole request-user-input path with nothing stubbed: a real agent calls the real
 * `create_terminal` tool, the daemon spawns a real PTY on a command that waits for a secret, the
 * tab raises the needs-input indicator, the agent is refused input on that terminal, and the
 * person types the secret in the browser.
 */
test("an agent opens a terminal for a password, cannot type in it, and the user can", async ({
  page,
}, testInfo) => {
  const { attention, terminalSnapshots } = captureSessionFrames(page);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `terminal-user-input-${testInfo.workerIndex}-`,
    title: AGENT_TITLE,
  });

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await waitForWorkspaceTabsVisible(page);

    let terminalId = "";
    await test.step("The agent opens a terminal and is refused input on it", async () => {
      await submitMessage(page, REQUEST_TERMINAL_INPUT_COMMAND);
      const opened = page.getByText(/^Opened terminal .+ for your password\.$/).first();
      await expect(opened).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByText(/Agent input refused: .*does not accept agent input/),
      ).toBeVisible({ timeout: 30_000 });
      const announced = (await opened.textContent()) ?? "";
      terminalId = /^Opened terminal (\S+) for your password\.$/.exec(announced.trim())?.[1] ?? "";
      expect(terminalId, `could not read the terminal id from "${announced}"`).toBeTruthy();
    });

    // Both tab rows render and one is hidden, so the visible filter picks the live one.
    const terminalTab = page
      .getByTestId(`workspace-tab-terminal_${terminalId}`)
      .filter({ visible: true })
      .first();

    await test.step("The tab tells the user it needs input", async () => {
      await expect(terminalTab).toBeVisible({ timeout: 30_000 });
      // The agent's name is pinned as the title, so the label stays put instead of following the
      // PTY to the command line.
      await expect(terminalTab).toContainText(TERMINAL_NAME);
      // Settle the activity transition, then record what actually rendered before asserting, so a
      // failure carries the wire frames and the rendered buckets instead of only a locator miss.
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: testInfo.outputPath("01-needs-input-indicator.png") });
      const buckets = await page.locator("[data-status-bucket]").evaluateAll(readStatusBuckets);
      await attachJson(testInfo, "rendered-status-buckets", buckets);
      await attachJson(testInfo, "terminals-changed-snapshots", terminalSnapshots);
      await attachJson(testInfo, "attention-notifications", attention);
      expect(buckets, "the terminal tab should carry the needs-input indicator").toContain(
        "needs_input",
      );
    });

    await test.step("The user types the secret and the command accepts it", async () => {
      await terminalTab.click();
      const surface = page
        .locator('[data-testid="terminal-surface"]')
        .filter({ visible: true })
        .first();
      await expect(surface).toBeVisible({ timeout: 30_000 });
      // The surface paints to a canvas, so terminal content is read back from the daemon
      // rather than from the DOM.
      await waitForTerminalText(agent.client, terminalId, PASSWORD_PROMPT);
      await page.screenshot({ path: testInfo.outputPath("02-password-prompt.png") });

      await surface.click();
      // Echo is off, the way sudo reads a password, so the recording shows nothing typed.
      await surface.pressSequentially(SECRET, { delay: 60 });
      await surface.press("Enter");

      const accepted = `PASEO_SECRET_ACCEPTED len=${SECRET.length}`;
      await waitForTerminalText(agent.client, terminalId, accepted);
      await page.screenshot({ path: testInfo.outputPath("03-secret-accepted.png") });
      const transcript = await agent.client.captureTerminal(terminalId, { stripAnsi: true });
      const transcriptPath = testInfo.outputPath("terminal-transcript.txt");
      await writeFile(transcriptPath, `${transcript.lines.join("\n")}\n`, "utf8");
      await testInfo.attach("terminal-transcript", {
        path: transcriptPath,
        contentType: "text/plain",
      });
    });

    await test.step("The notification names the agent that asked", async () => {
      const needsInput = attention.filter((entry) => entry.reason === "needs_input");
      expect(needsInput.length, "expected a needs_input attention notification").toBeGreaterThan(0);
      const first = needsInput[0];
      expect(first.title).toBe("Terminal needs input");
      expect(first.body).toBe(`${TERMINAL_NAME} · asked by Mock Load Test (${AGENT_TITLE})`);
    });
  } finally {
    await agent.cleanup();
  }
});
