export type ExplorerTab = "changes" | "files" | "pr" | "artifacts";

const EXPLORER_TABS: ReadonlySet<string> = new Set<ExplorerTab>([
  "changes",
  "files",
  "pr",
  "artifacts",
]);

export function isExplorerTab(value: unknown): value is ExplorerTab {
  return typeof value === "string" && EXPLORER_TABS.has(value);
}

export function buildExplorerCheckoutKey(serverId: string, cwd: string): string | null {
  const trimmedServerId = serverId.trim();
  const trimmedCwd = cwd.trim();
  if (!trimmedServerId || !trimmedCwd) {
    return null;
  }
  return `${trimmedServerId}::${trimmedCwd}`;
}

export function coerceExplorerTabForCheckout(tab: ExplorerTab, isGit: boolean): ExplorerTab {
  if (!isGit && tab === "changes") {
    return "files";
  }
  return tab;
}

export function resolveExplorerTabForCheckout(params: {
  serverId: string;
  cwd: string;
  isGit: boolean;
  explorerTabByCheckout: Record<string, ExplorerTab>;
}): ExplorerTab {
  const key = buildExplorerCheckoutKey(params.serverId, params.cwd);
  const stored = key ? params.explorerTabByCheckout[key] : null;
  const defaultTab: ExplorerTab = params.isGit ? "changes" : "files";
  const nextTab = stored && isExplorerTab(stored) ? stored : defaultTab;
  return coerceExplorerTabForCheckout(nextTab, params.isGit);
}
