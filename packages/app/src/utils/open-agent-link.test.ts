import { beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "@/utils/open-external-url";
import { openAgentLink } from "./open-agent-link";

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

describe("openAgentLink", () => {
  beforeEach(() => {
    vi.mocked(openExternalUrl).mockClear();
  });

  it("opens in the Paseo browser when the preference and runtime allow it", async () => {
    const openInBrowserTab = vi.fn();

    await openAgentLink({
      url: "https://claude.ai/code/artifact/example",
      behavior: "in-app",
      isElectron: true,
      openInBrowserTab,
    });

    expect(openInBrowserTab).toHaveBeenCalledWith("https://claude.ai/code/artifact/example");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("keeps the external-browser behavior by default", async () => {
    await openAgentLink({
      url: "https://claude.ai/code/artifact/example",
      behavior: "external",
      isElectron: true,
      openInBrowserTab: vi.fn(),
    });

    expect(openExternalUrl).toHaveBeenCalledWith("https://claude.ai/code/artifact/example");
  });

  it("falls back externally when an in-app browser is unavailable", async () => {
    await openAgentLink({
      url: "https://claude.ai/code/artifact/example",
      behavior: "in-app",
      isElectron: true,
      openInBrowserTab: null,
    });

    expect(openExternalUrl).toHaveBeenCalledWith("https://claude.ai/code/artifact/example");
  });
});
