import { afterEach, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const cleanupDaemons = new Set<TestPaseoDaemon>();
const cleanupClients = new Set<DaemonClient>();

afterEach(async () => {
  await Promise.all(Array.from(cleanupClients, (client) => client.close().catch(() => undefined)));
  cleanupClients.clear();
  await Promise.all(Array.from(cleanupDaemons, (daemon) => daemon.close().catch(() => undefined)));
  cleanupDaemons.clear();
});

async function connectedClient(): Promise<DaemonClient> {
  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(client);
  await client.connect();
  return client;
}

test("advertises PR auto-fix and answers its list and set requests", async () => {
  const client = await connectedClient();

  expect(client.getLastServerInfoMessage()?.features?.prAutoFix).toBe(true);
  expect(await client.listAgentPrWatches()).toEqual([]);
  await expect(client.setAgentPrWatch("missing-agent", true)).rejects.toThrow(
    "Agent missing-agent not found or archived",
  );
  expect(await client.setAgentPrWatch("missing-agent", false)).toBeNull();
}, 60_000);

test("answers project PR automation and review request RPCs", async () => {
  const client = await connectedClient();
  const settings = {
    autoReview: true,
    reviewProvider: null,
    postReviews: false,
    autoFixAgentPullRequests: false,
  };

  await expect(client.setProjectPrAutomation("missing-project", settings)).rejects.toThrow(
    "Choose a reviewer provider",
  );
  await expect(
    client.setProjectPrAutomation("missing-project", { ...settings, reviewProvider: "codex" }),
  ).rejects.toThrow("Project not found");
  expect(await client.listReviewRequests()).toEqual({ reviewRequests: [], errors: [] });
  await expect(client.startPrReview({ projectId: "missing-project", prNumber: 1 })).rejects.toThrow(
    "Project not found",
  );
}, 60_000);
