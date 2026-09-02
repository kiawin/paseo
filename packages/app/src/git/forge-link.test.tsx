/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useOpenUrlInWorkspaceBrowserTab } from "@/desktop/browser/open-in-workspace";
import { isElectronRuntime } from "@/desktop/host";
import { useSettings } from "@/hooks/use-settings";
import { openExternalUrl } from "@/utils/open-external-url";
import { ForgeLinkProvider, useForgeLinkOpener, useForgeMarkdownLinkPress } from "./forge-link";

/**
 * The two platform boundaries are mocked and nothing else: `isElectronRuntime` has no answer in
 * jsdom, and opening a browser tab needs the workspace layout store plus an Electron webview.
 * The destination rule itself (`resolveLinkDestination`) and the opener run for real, so a test
 * that passes here is one where the setting, the runtime, and the workspace actually agreed.
 */
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn(async () => {}) }));
vi.mock("@/desktop/host", () => ({ isElectronRuntime: vi.fn(() => true) }));
vi.mock("@/desktop/browser/open-in-workspace", () => ({
  useOpenUrlInWorkspaceBrowserTab: vi.fn(),
}));
vi.mock("@/hooks/use-settings", () => ({ useSettings: vi.fn() }));

const PR_URL = "https://github.com/acme/repo/pull/42";
const WORKSPACE_KEY = "srv_1:wks_1";

function setSettings(settings: { forgeLinkBehavior: string; agentLinkBehavior?: string }): void {
  vi.mocked(useSettings).mockImplementation(((selector: (state: unknown) => unknown) =>
    selector({ agentLinkBehavior: "external", ...settings })) as typeof useSettings);
}

function wrapper(workspaceKey: string | null) {
  return ({ children }: { children: ReactNode }) => (
    <ForgeLinkProvider workspaceKey={workspaceKey}>{children}</ForgeLinkProvider>
  );
}

describe("forge links", () => {
  let openInBrowserTab: Mock<(url: string) => void>;

  beforeEach(() => {
    vi.mocked(openExternalUrl).mockClear();
    vi.mocked(isElectronRuntime).mockReturnValue(true);
    openInBrowserTab = vi.fn<(url: string) => void>();
    vi.mocked(useOpenUrlInWorkspaceBrowserTab).mockImplementation((workspaceKey) =>
      workspaceKey ? openInBrowserTab : null,
    );
    setSettings({ forgeLinkBehavior: "external" });
  });

  it("opens in Paseo when the setting, the runtime, and the workspace all allow it", () => {
    setSettings({ forgeLinkBehavior: "in-app" });

    const { result } = renderHook(() => useForgeLinkOpener(), {
      wrapper: wrapper(WORKSPACE_KEY),
    });
    result.current(PR_URL);

    expect(useOpenUrlInWorkspaceBrowserTab).toHaveBeenCalledWith(WORKSPACE_KEY);
    expect(openInBrowserTab).toHaveBeenCalledWith(PR_URL);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("keeps the external browser as the default", () => {
    const { result } = renderHook(() => useForgeLinkOpener(), {
      wrapper: wrapper(WORKSPACE_KEY),
    });
    result.current(PR_URL);

    expect(openExternalUrl).toHaveBeenCalledWith(PR_URL);
    expect(openInBrowserTab).not.toHaveBeenCalled();
  });

  it("reads the forge preference rather than the agent one", () => {
    setSettings({ forgeLinkBehavior: "in-app", agentLinkBehavior: "external" });

    const { result } = renderHook(() => useForgeLinkOpener(), {
      wrapper: wrapper(WORKSPACE_KEY),
    });
    result.current(PR_URL);

    expect(openInBrowserTab).toHaveBeenCalledWith(PR_URL);
  });

  it("falls back to the external browser for a surface with no workspace", () => {
    setSettings({ forgeLinkBehavior: "in-app" });

    const { result } = renderHook(() => useForgeLinkOpener(), { wrapper: wrapper(null) });
    result.current(PR_URL);

    expect(openExternalUrl).toHaveBeenCalledWith(PR_URL);
    expect(openInBrowserTab).not.toHaveBeenCalled();
  });

  it("falls back to the external browser off Electron, where there is no tab to open", () => {
    setSettings({ forgeLinkBehavior: "in-app" });
    vi.mocked(isElectronRuntime).mockReturnValue(false);

    const { result } = renderHook(() => useForgeLinkOpener(), {
      wrapper: wrapper(WORKSPACE_KEY),
    });
    result.current(PR_URL);

    expect(openExternalUrl).toHaveBeenCalledWith(PR_URL);
    expect(openInBrowserTab).not.toHaveBeenCalled();
  });

  it("sends a link from a surface mounted outside any provider to the external browser", () => {
    setSettings({ forgeLinkBehavior: "in-app" });

    const { result } = renderHook(() => useForgeLinkOpener());
    result.current(PR_URL);

    expect(openExternalUrl).toHaveBeenCalledWith(PR_URL);
    expect(openInBrowserTab).not.toHaveBeenCalled();
  });

  it("routes markdown links in forge content through the same opener", () => {
    setSettings({ forgeLinkBehavior: "in-app" });

    const { result } = renderHook(() => useForgeMarkdownLinkPress(), {
      wrapper: wrapper(WORKSPACE_KEY),
    });

    // False keeps the renderer from also following the href.
    expect(result.current(PR_URL)).toBe(false);
    expect(openInBrowserTab).toHaveBeenCalledWith(PR_URL);
  });
});
