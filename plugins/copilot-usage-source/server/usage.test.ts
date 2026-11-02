import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, discoverSession, fetchUsage } from "./usage.js";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const key = url.toString();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unmocked fetch: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("copilot usage source", () => {
  let homeDir: string;
  let fetchApi: typeof fetch;
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "usage-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    for (const key of [
      "APPDATA",
      "COPILOT_TOKEN",
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "CURSOR_ACCESS_TOKEN",
      "CURSOR_TOKEN",
      "ZAI_API_KEY",
      "GLM_API_KEY",
      "GROK_API_KEY",
      "GROK_TOKEN",
      "KIMI_TOKEN",
      "KIMI_API_KEY",
      "KIMI_CODE_HOME",
      "MINIMAX_API_KEY",
      "MINIMAX_BASE_URL",
    ])
      delete process.env[key];
    fetchApi = mockFetch(new Map());
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });
  function service(
    _options: {
      platform?: typeof process.platform;
      keychain?: () => Promise<unknown | null>;
      cursorHomeDir?: string;
      kimiHomeDir?: string;
    } = {},
  ) {
    return {
      listUsage: async () => {
        const report = await fetchFirst((url, init) => fetchApi(url, init));
        return {
          providers: [
            {
              providerId: "copilot",
              ...report,
              error: report.status === "error" ? report.error : null,
              planLabel: report.status === "available" ? (report.planLabel ?? null) : null,
            },
          ],
        };
      },
    };
  }
  function findProvider(
    result: { providers: Array<{ providerId: string } & UsageReport> },
    id: string,
  ) {
    const report = result.providers.find((item) => item.providerId === id);
    if (!report) throw new Error(`Missing usage source ${id}`);
    return report;
  }
  it("fetches Copilot usage from COPILOT_TOKEN", async () => {
    process.env["COPILOT_TOKEN"] = "copilot_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.github.com/copilot_internal/user",
          () =>
            jsonResponse({
              copilot_plan: "business",
              quota_reset_date: "2026-07-01T00:00:00Z",
            }),
        ],
      ]),
    );

    const copilot = findProvider(await service().listUsage(), "copilot");

    expect(copilot).toMatchObject({
      status: "available",
      planLabel: "business",
      windows: [],
      balances: [],
      details: [{ id: "reset", label: "Quota reset", value: "2026-07-01T00:00:00Z" }],
    });
  });
});

function snapshot(overrides: Record<string, unknown>) {
  return {
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: 100,
    quota_remaining: 0,
    unlimited: true,
    has_quota: true,
    quota_reset_at: 0,
    token_based_billing: true,
    credits_used: 0,
    overage_entitlement: 0,
    remaining: 0,
    entitlement: 0,
    ...overrides,
  };
}

async function fetchBody(body: unknown) {
  const previous = process.env["COPILOT_TOKEN"];
  try {
    process.env["COPILOT_TOKEN"] = "fixture-token";
    return await fetchUsage({ store: "env", locator: "COPILOT_TOKEN" }, async () =>
      jsonResponse(body),
    );
  } finally {
    if (previous === undefined) delete process.env["COPILOT_TOKEN"];
    else process.env["COPILOT_TOKEN"] = previous;
  }
}

describe("quota snapshots", () => {
  // Shape captured from an enterprise seat with token-based billing.
  it("reports credits used on an unlimited enterprise seat without a cap", async () => {
    const report = await fetchBody({
      copilot_plan: "enterprise",
      access_type_sku: "copilot_enterprise_seat_quota",
      quota_reset_date: "2026-12-01",
      token_based_billing: true,
      quota_snapshots: {
        chat: snapshot({ quota_id: "chat" }),
        completions: snapshot({ quota_id: "completions" }),
        premium_interactions: snapshot({
          quota_id: "premium_interactions",
          overage_permitted: true,
          credits_used: 243,
        }),
      },
    });

    expect(report).toEqual({
      status: "available",
      planLabel: "enterprise",
      windows: [],
      balances: [
        {
          id: "premium_interactions",
          label: "Premium requests",
          used: 243,
          remaining: null,
          limit: null,
          unit: "credits",
          resetsAt: "2026-12-01",
          tone: "default",
        },
      ],
      details: [
        { id: "reset", label: "Quota reset", value: "2026-12-01" },
        { id: "credit_value", label: "Credit value", value: "$2.43" },
        { id: "overage", label: "Overage", value: "Permitted" },
      ],
    });
  });

  it("reports a capped premium quota as a summary window and balance", async () => {
    const report = await fetchBody({
      copilot_plan: "individual",
      quota_reset_date: "2026-12-01",
      quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
      quota_snapshots: {
        premium_interactions: snapshot({
          unlimited: false,
          token_based_billing: false,
          credits_used: null,
          entitlement: 300,
          remaining: 75,
          percent_remaining: 25,
          overage_permitted: true,
          overage_count: 4,
        }),
      },
    });

    expect(report).toMatchObject({
      status: "available",
      windows: [
        {
          id: "premium_interactions",
          label: "Premium requests",
          shortLabel: "prem",
          summary: true,
          usedPct: 75,
          remainingPct: 25,
          resetsAt: "2026-12-01T00:00:00.000Z",
          tone: "ok",
        },
      ],
      balances: [
        {
          id: "premium_interactions",
          used: 225,
          remaining: 75,
          limit: 300,
          unit: "requests",
          tone: "ok",
        },
      ],
      details: [
        { id: "reset", label: "Quota reset", value: "2026-12-01" },
        { id: "overage", label: "Overage", value: "Permitted · 4 used" },
      ],
    });
  });

  it("skips a malformed snapshot and keeps the others", async () => {
    const report = await fetchBody({
      quota_snapshots: {
        chat: { unlimited: "yes" },
        premium_interactions: snapshot({ credits_used: 5 }),
      },
    });

    expect(report).toMatchObject({
      status: "available",
      balances: [{ id: "premium_interactions", used: 5 }],
    });
  });
});

describe("session discovery", () => {
  const session = (env: Record<string, string>, provider = "copilot") =>
    ({ kind: "session", provider, env }) as const;

  it("ignores other providers", async () => {
    expect(await discoverSession(session({ GH_TOKEN: "x" }, "codex"))).toEqual([]);
  });

  it("names an env token this process shares with the session", async () => {
    const previous = process.env["GH_TOKEN"];
    try {
      process.env["GH_TOKEN"] = "shared-token";
      expect(await discoverSession(session({ GH_TOKEN: "shared-token" }))).toEqual([
        { key: "default", input: { store: "env", locator: "GH_TOKEN" } },
      ]);
      expect(await discoverSession(session({ GH_TOKEN: "session-only-token" }))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["GH_TOKEN"];
      else process.env["GH_TOKEN"] = previous;
    }
  });

  it("falls back to the GitHub CLI login in the session's config directory", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "usage-gh-"));
    try {
      await writeFile(
        join(directory, "hosts.yml"),
        "github.com:\n    oauth_token: gho_fixture\n    user: someone\n",
      );
      expect(await discoverSession(session({ GH_CONFIG_DIR: directory }))).toEqual([
        { key: "default", input: { store: "file", locator: join(directory, "hosts.yml") } },
      ]);
      expect(await discoverSession(session({ HOME: directory }))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("discovery returns a locator when fetch finds copilot credentials", async () => {
  const previous = process.env["COPILOT_TOKEN"];
  try {
    process.env["COPILOT_TOKEN"] = "fixture-token";
    let requested = false;
    await fetchFirst(async () => {
      requested = true;
      return new Response(null, { status: 401 });
    });
    expect(requested).toBe(true);
    expect(await discover()).toEqual([
      { key: "default", input: { store: "env", locator: "COPILOT_TOKEN" } },
    ]);
  } finally {
    if (previous === undefined) delete process.env["COPILOT_TOKEN"];
    else process.env["COPILOT_TOKEN"] = previous;
  }
});

describe("account discovery", () => {
  it.each(["empty home", "unrelated files"])("returns no accounts for %s", async (scenario) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "usage-empty-"));
    const original = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      process.env.HOME = directory;
      process.env.USERPROFILE = directory;
      if (scenario === "unrelated files") await writeFile(join(directory, "unrelated.json"), "{}");
      expect(await discover()).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, original);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function fetchFirst(fetchApi: typeof fetch) {
  const accounts = await discover();
  const account = accounts[0];
  if (!account) throw new Error("No configured account");
  return fetchUsage(account.input as Parameters<typeof fetchUsage>[0], fetchApi);
}

it.each([401, 403])("reports an existing login rejected with HTTP %i", async (status) => {
  const previous = process.env["COPILOT_TOKEN"];
  try {
    process.env["COPILOT_TOKEN"] = "fixture-rejected-login";
    const report = await fetchUsage(
      { store: "env", locator: "COPILOT_TOKEN" },
      async () => new Response(null, { status }),
    );
    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status } });
  } finally {
    if (previous === undefined) delete process.env["COPILOT_TOKEN"];
    else process.env["COPILOT_TOKEN"] = previous;
  }
});
