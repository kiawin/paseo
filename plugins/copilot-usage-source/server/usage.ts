import type { UsageInput } from "../shared/input.js";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  balanceToneFromRemaining,
  unavailable,
  usedPctOf,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const ApiOptionalNumberSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.number().finite().optional(),
);

const ApiOptionalBooleanSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.boolean().optional(),
);

const QuotaSnapshotSchema = z.object({
  unlimited: ApiOptionalBooleanSchema,
  entitlement: ApiOptionalNumberSchema,
  remaining: ApiOptionalNumberSchema,
  percent_remaining: ApiOptionalNumberSchema,
  credits_used: ApiOptionalNumberSchema,
  overage_permitted: ApiOptionalBooleanSchema,
  overage_count: ApiOptionalNumberSchema,
  token_based_billing: ApiOptionalBooleanSchema,
});
type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

const CopilotUsageResponseSchema = z.object({
  copilot_plan: ApiOptionalStringSchema,
  quota_reset_date: ApiOptionalStringSchema,
  quota_reset_date_utc: ApiOptionalStringSchema,
  token_based_billing: ApiOptionalBooleanSchema,
  // Each snapshot is parsed on its own so one malformed quota cannot hide the others.
  quota_snapshots: z.record(z.string(), z.unknown()).nullish(),
});

// The quota IDs Copilot reports. Premium requests are the metered quota; chat and completions
// are unlimited on paid plans and only shown when they are capped or carry usage.
const QUOTAS = [
  { id: "premium_interactions", label: "Premium requests", shortLabel: "prem", summary: true },
  { id: "chat", label: "Chat", shortLabel: "chat", summary: false },
  { id: "completions", label: "Completions", shortLabel: "comp", summary: false },
] as const;

const TOKEN_ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

// GitHub's published rate for every plan; see
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing. This is the list
// value of the credits used, not a bill: Business and Enterprise seats draw from an org-wide
// included pool first, and this endpoint does not report that pool.
const USD_PER_AI_CREDIT = 0.01;

// macOS Keychain services holding a GitHub login, in Copilot CLI's order: its own
// `copilot login` entry (a raw token), then the GitHub CLI's (go-keyring, often prefixed). The
// service is the input's locator.
const KEYCHAIN_SERVICES = ["copilot-cli", "gh:github.com"] as const;
const KEYCHAIN_TIMEOUT_MS = 2_000;
const execFileAsync = promisify(execFile);

export type SecurityCommandRunner = (args: string[]) => Promise<string | null>;

async function runSecurityCommand(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("security", args, { timeout: KEYCHAIN_TIMEOUT_MS });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// go-keyring stores values as-is, base64 behind "go-keyring-base64:", or hex behind
// "go-keyring-encoded:".
export function decodeKeyringValue(raw: string): string | undefined {
  let value = raw;
  if (raw.startsWith("go-keyring-base64:"))
    value = Buffer.from(raw.slice("go-keyring-base64:".length), "base64").toString("utf8");
  else if (raw.startsWith("go-keyring-encoded:"))
    value = Buffer.from(raw.slice("go-keyring-encoded:".length), "hex").toString("utf8");
  return value.trim() || undefined;
}

async function readToken(
  input: UsageInput,
  runSecurity: SecurityCommandRunner = runSecurityCommand,
): Promise<string | undefined> {
  if (input.store === "env") return process.env[input.locator];
  if (input.store === "keychain") {
    const raw = await runSecurity(["find-generic-password", "-s", input.locator, "-w"]);
    return raw ? decodeKeyringValue(raw) : undefined;
  }
  try {
    const raw = await fs.readFile(input.locator, "utf8");
    return raw.match(/oauth_token:\s*["']?([a-zA-Z0-9_-]+)["']?/)?.[1];
  } catch {
    return undefined;
  }
}

export async function discover(
  platform: NodeJS.Platform = process.platform,
  runSecurity: SecurityCommandRunner = runSecurityCommand,
): Promise<UsageAccount[]> {
  const candidates: UsageInput[] = ["COPILOT_TOKEN", ...TOKEN_ENV_KEYS, "GITHUB_PAT"].map(
    (locator) => ({ store: "env", locator }),
  );
  if (process.env.APPDATA)
    candidates.push({
      store: "file",
      locator: join(process.env.APPDATA, "GitHub CLI", "hosts.yml"),
    });
  candidates.push({ store: "file", locator: join(homedir(), ".config", "gh", "hosts.yml") });
  // The Keychain goes last: reading it can raise a macOS access prompt, so it runs only when no
  // other store holds a login.
  if (platform === "darwin") candidates.push(...keychainInputs());
  for (const input of candidates)
    if (await readToken(input, runSecurity)) return [{ key: "default", input }];
  return [];
}

function keychainInputs(): UsageInput[] {
  return KEYCHAIN_SERVICES.map((locator) => ({ store: "keychain", locator }));
}

// Mirrors Copilot CLI's login order: token env vars first, then the stored logins. An env
// token can only be named by an input when this process sees the same value; otherwise the
// session runs on a credential we cannot reach, and any other store would report a different
// login. On macOS, where gh and `copilot login` keep the token in the Keychain, the Keychain
// is read after hosts.yml so a plain-text login never costs an access prompt.
export async function discoverSession(
  scope: Extract<UsageScope, { kind: "session" }>,
  platform: NodeJS.Platform = process.platform,
  runSecurity: SecurityCommandRunner = runSecurityCommand,
): Promise<UsageAccount[]> {
  if (scope.provider !== "copilot") return [];
  const envKey = TOKEN_ENV_KEYS.find((key) => scope.env[key]);
  if (envKey) {
    if (process.env[envKey] !== scope.env[envKey]) return [];
    return [{ key: "default", input: { store: "env", locator: envKey } }];
  }
  const candidates: UsageInput[] = [{ store: "file", locator: ghHostsPath(scope.env) }];
  if (platform === "darwin") candidates.push(...keychainInputs());
  for (const input of candidates)
    if (await readToken(input, runSecurity)) return [{ key: "default", input }];
  return [];
}

function ghHostsPath(env: Record<string, string>): string {
  if (env.GH_CONFIG_DIR) return join(env.GH_CONFIG_DIR, "hosts.yml");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "gh", "hosts.yml");
  if (env.APPDATA) return join(env.APPDATA, "GitHub CLI", "hosts.yml");
  return join(env.HOME || env.USERPROFILE || homedir(), ".config", "gh", "hosts.yml");
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
  runSecurity: SecurityCommandRunner = runSecurityCommand,
): Promise<UsageReport> {
  const token = await readToken(input, runSecurity);
  if (!token) throw new Error("Copilot login store no longer exists");

  const res = await fetchApi("https://api.github.com/copilot_internal/user", {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-Github-Api-Version": "2025-04-01",
    },
  });

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`Copilot usage API returned ${res.status}`);

  const resp = CopilotUsageResponseSchema.parse(await res.json());
  const { windows, balances, details } = quotaRows(resp);
  // Rows already show their reset; the date alone is only useful when there are no rows.
  if (resp.quota_reset_date && windows.length === 0 && balances.length === 0)
    details.unshift({ id: "reset", label: "Quota reset", value: resp.quota_reset_date });

  return {
    status: "available",
    planLabel: resp.copilot_plan || undefined,
    windows,
    balances,
    details,
  };
}

function quotaRows(resp: z.infer<typeof CopilotUsageResponseSchema>) {
  const resetsAt = resp.quota_reset_date_utc ?? resp.quota_reset_date ?? null;
  const windows: UsageWindow[] = [];
  const balances: UsageBalance[] = [];
  const details: UsageDetail[] = [];

  for (const quota of QUOTAS) {
    const parsed = QuotaSnapshotSchema.safeParse(resp.quota_snapshots?.[quota.id]);
    if (!parsed.success || resp.quota_snapshots?.[quota.id] == null) continue;
    const snapshot = parsed.data;
    const balance = quotaBalance(quota, snapshot, resp.token_based_billing, resetsAt);
    if (!balance) continue;
    // One row per quota: a capped quota is a window, so it can be pinned to the sidebar summary;
    // an unlimited one has no percentage and stays a balance.
    if (balance.limit == null) balances.push(balance);
    else
      windows.push(
        windowFromUsedPct({
          id: quota.id,
          label: quota.label,
          shortLabel: quota.shortLabel,
          summary: quota.summary,
          utilizationPct:
            snapshot.percent_remaining !== undefined
              ? 100 - snapshot.percent_remaining
              : usedPctOf(balance.used, balance.limit),
          resetsAt,
          tone: balance.tone,
        }),
      );
    if (quota.id === "premium_interactions") details.push(...premiumDetails(balance, snapshot));
  }
  return { windows, balances, details };
}

function premiumDetails(balance: UsageBalance, snapshot: QuotaSnapshot): UsageDetail[] {
  const details: UsageDetail[] = [];
  if (balance.unit === "credits" && typeof balance.used === "number")
    details.push({
      id: "credit_value",
      label: "Credit value",
      value: `$${(balance.used * USD_PER_AI_CREDIT).toFixed(2)}`,
    });
  if (snapshot.overage_permitted !== undefined)
    details.push({
      id: "overage",
      label: "Overage",
      value: overageValue(snapshot.overage_permitted, snapshot.overage_count),
    });
  return details;
}

function quotaBalance(
  quota: (typeof QUOTAS)[number],
  snapshot: QuotaSnapshot,
  accountTokenBilling: boolean | undefined,
  resetsAt: string | null,
): UsageBalance | null {
  // Unlimited quotas report entitlement and remaining as 0; they are not a cap.
  const limit = snapshot.unlimited ? null : (snapshot.entitlement ?? null);
  const remaining = snapshot.unlimited ? null : (snapshot.remaining ?? null);
  const used =
    snapshot.credits_used ?? (limit !== null && remaining !== null ? limit - remaining : null);
  if (limit === null && !quota.summary && !(used !== null && used > 0)) return null;
  const tokenBilling = snapshot.token_based_billing ?? accountTokenBilling ?? false;
  return {
    id: quota.id,
    label: quota.label,
    used,
    remaining,
    limit,
    unit: tokenBilling ? "credits" : "requests",
    resetsAt,
    tone: limit === null ? "default" : balanceToneFromRemaining(remaining),
  };
}

function overageValue(permitted: boolean, count: number | undefined): string {
  if (!permitted) return "Not permitted";
  return count ? `Permitted · ${count} used` : "Permitted";
}
