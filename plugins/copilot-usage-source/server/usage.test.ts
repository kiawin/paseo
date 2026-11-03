import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeKeyringValue, discover, discoverSession, fetchUsage } from "./usage.js";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const key = url.toString();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unmocked fetch: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

// Stands in for the `security` CLI so Keychain lookups run on any platform. Maps a service to
// its stored value.
function keychainWith(entries: Record<string, string>) {
  return vi.fn(async (args: string[]) => entries[args[args.indexOf("-s") + 1]!] ?? null);
}
const noKeychain = async () => null;

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
      balances: [],
      details: [
        { id: "overage", label: "Overage", value: "Permitted · 4 used" },
        {
          id: "premium_remaining",
          label: "Premium requests remaining",
          value: "75 / 300",
        },
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
    expect(
      await discoverSession(session({ GH_TOKEN: "x" }, "codex"), "darwin", noKeychain),
    ).toEqual([]);
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
      expect(await discoverSession(session({ HOME: directory }), "darwin", noKeychain)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to the Keychain on macOS when hosts.yml holds no token", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "usage-gh-"));
    try {
      // gh with the keyring store writes hosts.yml without an oauth_token.
      await writeFile(join(directory, "hosts.yml"), "github.com:\n    user: someone\n");
      const keychain = keychainWith({ "gh:github.com": "go-keyring-base64:Z2hvX2tleWNoYWlu" });
      expect(
        await discoverSession(session({ GH_CONFIG_DIR: directory }), "darwin", keychain),
      ).toEqual([{ key: "default", input: { store: "keychain", locator: "gh:github.com" } }]);
      expect(keychain).toHaveBeenCalledWith(["find-generic-password", "-s", "copilot-cli", "-w"]);
      expect(
        await discoverSession(session({ GH_CONFIG_DIR: directory }), "linux", keychain),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers hosts.yml over the Keychain in a session", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "usage-gh-"));
    try {
      await writeFile(join(directory, "hosts.yml"), "github.com:\n    oauth_token: gho_file\n");
      const keychain = keychainWith({ "copilot-cli": "gho_keychain" });
      expect(
        await discoverSession(session({ GH_CONFIG_DIR: directory }), "darwin", keychain),
      ).toEqual([
        { key: "default", input: { store: "file", locator: join(directory, "hosts.yml") } },
      ]);
      expect(keychain).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("macOS Keychain", () => {
  let homeDir: string;
  let original: NodeJS.ProcessEnv;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "usage-keychain-"));
    original = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("falls back to Copilot CLI's Keychain login when no other store holds one", async () => {
    const keychain = keychainWith({ "copilot-cli": "gho_copilot", "gh:github.com": "gho_gh" });
    const accounts = await discover("darwin", keychain);
    expect(accounts).toEqual([
      { key: "default", input: { store: "keychain", locator: "copilot-cli" } },
    ]);

    let authorization: string | null = null;
    const report = await fetchUsage(
      accounts[0]!.input as Parameters<typeof fetchUsage>[0],
      (async (_url: RequestInfo | URL, init?: RequestInit) => {
        authorization =
          (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
        return jsonResponse({ copilot_plan: "enterprise", quota_snapshots: {} });
      }) as unknown as typeof fetch,
      keychain,
    );
    expect(authorization).toBe("token gho_copilot");
    expect(report).toMatchObject({ status: "available", planLabel: "enterprise" });
  });

  it("uses gh's Keychain login when Copilot CLI has none", async () => {
    const keychain = keychainWith({ "gh:github.com": "go-keyring-base64:Z2hvX2do" });
    expect(await discover("darwin", keychain)).toEqual([
      { key: "default", input: { store: "keychain", locator: "gh:github.com" } },
    ]);
  });

  it("reads env and file stores before the Keychain", async () => {
    const keychain = keychainWith({ "copilot-cli": "gho_keychain" });
    process.env.GH_TOKEN = "gho_env";
    expect(await discover("darwin", keychain)).toEqual([
      { key: "default", input: { store: "env", locator: "GH_TOKEN" } },
    ]);
    delete process.env.GH_TOKEN;
    const hostsPath = join(homeDir, ".config", "gh", "hosts.yml");
    mkdirSync(join(homeDir, ".config", "gh"), { recursive: true });
    writeFileSync(hostsPath, "github.com:\n    oauth_token: gho_file\n");
    expect(await discover("darwin", keychain)).toEqual([
      { key: "default", input: { store: "file", locator: hostsPath } },
    ]);
    expect(keychain).not.toHaveBeenCalled();
  });

  it("never reads the Keychain outside macOS", async () => {
    const keychain = keychainWith({ "copilot-cli": "gho_keychain" });
    expect(await discover("linux", keychain)).toEqual([]);
    expect(await discover("win32", keychain)).toEqual([]);
    expect(keychain).not.toHaveBeenCalled();
  });

  it.each([
    ["a raw token", "gho_raw", "gho_raw"],
    ["go-keyring base64", "go-keyring-base64:Z2hvX2I2NA==", "gho_b64"],
    ["go-keyring hex", "go-keyring-encoded:67686f5f686578", "gho_hex"],
  ])("decodes %s", (_name, raw, token) => {
    expect(decodeKeyringValue(raw)).toBe(token);
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
    expect(await discover(process.platform, noKeychain)).toEqual([
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
      expect(await discover("darwin", noKeychain)).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, original);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function fetchFirst(fetchApi: typeof fetch) {
  const accounts = await discover(process.platform, noKeychain);
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

it.each([
  { remaining: 1500, percentRemaining: 100, usedPct: 0 },
  { remaining: 1125, percentRemaining: 75, usedPct: 25 },
  { remaining: 0, percentRemaining: 0, usedPct: 100 },
])(
  "reports premium quota with $remaining requests remaining",
  async ({ remaining, percentRemaining, usedPct }) => {
    const report = await fetchPremiumQuota({
      entitlement: 1500,
      remaining,
      percent_remaining: percentRemaining,
      unlimited: false,
    });
    expect(report).toMatchObject({
      status: "available",
      planLabel: "individual",
      windows: [
        {
          id: "premium_interactions",
          label: "Premium requests",
          usedPct,
          remainingPct: percentRemaining,
          resetsAt: "2026-12-01T00:00:00.000Z",
        },
      ],
      details: expect.arrayContaining([
        {
          id: "premium_remaining",
          label: "Premium requests remaining",
          value: `${remaining} / 1500`,
        },
      ]),
    });
  },
);

it.each([
  undefined,
  null,
  { unlimited: true, percent_remaining: 100, remaining: 1500, entitlement: 1500 },
])(
  "does not invent a finite quota for absent or unlimited premium snapshots (%j)",
  async (premium) => {
    const report = await fetchPremiumQuota(premium);
    expect(report).toMatchObject({
      status: "available",
      windows: [],
      details: [{ id: "reset", label: "Quota reset", value: "2026-12-01" }],
    });
  },
);

it("uses the legacy reset for a percentage without inventing missing counts", async () => {
  const report = await fetchPremiumQuota({ percent_remaining: 60, unlimited: false }, null);
  expect(report).toMatchObject({
    status: "available",
    windows: [{ usedPct: 40, remainingPct: 60, resetsAt: "2026-12-01" }],
    details: [],
  });
});

async function fetchPremiumQuota(
  premium: unknown,
  utcReset: string | null = "2026-12-01T00:00:00.000Z",
) {
  const { writeFile } = await import("node:fs/promises");
  const directory = mkdtempSync(join(tmpdir(), "copilot-premium-"));
  const locator = join(directory, "hosts.yml");
  try {
    await writeFile(locator, "github.com:\n  oauth_token: fixture-copilot\n");
    return await fetchUsage({ store: "file", locator }, async () =>
      jsonResponse({
        copilot_plan: "individual",
        quota_reset_date: "2026-12-01",
        quota_reset_date_utc: utcReset,
        quota_snapshots: {
          premium_interactions: premium,
          chat: { unlimited: true, percent_remaining: 100 },
          completions: { unlimited: true, percent_remaining: 100 },
        },
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
