import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Pressable, Text } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { ContextWindowDetails } from "../context-window-details";

const platform = vi.hoisted(() => ({ isWeb: true, isNative: false }));
const fixture = vi.hoisted(() => ({
  supportsContextUsage: false,
  getAgentContextUsage: vi.fn(),
}));

vi.mock("@/constants/platform", () => ({
  get isWeb() {
    return platform.isWeb;
  },
  get isNative() {
    return platform.isNative;
  },
}));

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? children : null,
}));

vi.mock("@/components/ui/floating", () => ({
  FloatingSurface: ({
    children,
    pointerEvents,
    testID,
  }: {
    children: React.ReactNode;
    pointerEvents: string;
    testID: string;
  }) => (
    <div data-testid={testID} data-pointer-events={pointerEvents}>
      {children}
    </div>
  ),
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="gesture-root">{children}</div>
  ),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
  getHostRuntimeStore: () => ({
    getClient: () => ({ getAgentContextUsage: fixture.getAgentContextUsage }),
  }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        host: { serverInfo: { features: { agentContextUsage: fixture.supportsContextUsage } } },
      },
    }),
}));
vi.mock("@/usage", () => ({ AgentUsage: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { tokens?: string }) =>
      options?.tokens ? `${options.tokens} tokens` : key,
    i18n: { resolvedLanguage: "en" },
  }),
}));
vi.mock("lucide-react-native", () => ({ ChevronDown: () => null, ChevronRight: () => null }));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  useBottomSheetModalInternal: () => null,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  FadeIn: { duration: () => undefined },
  FadeOut: { duration: () => undefined },
}));

vi.mock("react-native-unistyles", () => ({
  withUnistyles: (component: unknown) => component,
  StyleSheet: {
    create: (styles: unknown) =>
      typeof styles === "function"
        ? styles({
            colors: {
              foreground: "black",
              foregroundMuted: "gray",
              surface3: "gray",
              popover: "white",
              borderAccent: "gray",
              interactionHighlight: "gray",
              palette: {
                blue: { 500: "blue" },
                purple: { 500: "purple" },
                green: { 500: "green" },
                orange: { 500: "orange" },
                amber: { 500: "orange" },
                zinc: { 500: "gray" },
              },
            },
            spacing: { 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16 },
            fontSize: { sm: 12, base: 14 },
            borderRadius: { full: 999, xl: 12 },
            borderWidth: { 1: 1 },
            shadow: { md: {} },
          })
        : styles,
  },
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  platform.isWeb = true;
  platform.isNative = false;
  fixture.supportsContextUsage = false;
  fixture.getAgentContextUsage.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function renderTrigger({
  childDisabled,
  onPress,
}: {
  childDisabled: boolean;
  onPress: () => void;
}): void {
  act(() => {
    root?.render(
      <Tooltip>
        <TooltipTrigger asChild>
          <Pressable disabled={childDisabled} onPress={onPress} testID="trigger">
            <Text>Send</Text>
          </Pressable>
        </TooltipTrigger>
      </Tooltip>,
    );
  });
}

function pressTrigger(): void {
  const trigger = container?.querySelector('[data-testid="trigger"]');
  expect(trigger).not.toBeNull();

  act(() => {
    trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

describe("TooltipTrigger", () => {
  it("keeps an asChild trigger disabled when the child is disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: true, onPress });
    pressTrigger();

    expect(onPress).not.toHaveBeenCalled();
  });

  it("keeps an asChild trigger interactive when the child is not disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: false, onPress });
    pressTrigger();

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("native interactive tooltip", () => {
  it("lets controls respond and dismisses from the backdrop", () => {
    platform.isWeb = false;
    platform.isNative = true;
    const onPress = vi.fn();
    act(() => {
      root?.render(
        <Tooltip defaultOpen enabledOnMobile>
          <TooltipContent interactive testID="details">
            <Pressable onPress={onPress} testID="detail-action">
              <Text>Expand</Text>
            </Pressable>
          </TooltipContent>
        </Tooltip>,
      );
    });
    const details = container?.querySelector('[data-testid="details"]');
    expect(container?.querySelector('[data-testid="gesture-root"]')).not.toBeNull();
    expect(details?.getAttribute("data-pointer-events")).toBe("auto");
    act(() => {
      container
        ?.querySelector('[data-testid="detail-action"]')
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(container?.querySelector('[data-testid="details"]')).not.toBeNull();
    act(() => {
      container
        ?.querySelector('[data-testid="tooltip-dismiss"]')
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(container?.querySelector('[data-testid="details"]')).toBeNull();
  });
});

describe("context window details", () => {
  it("requests data only from capable hosts and expands the matching category", async () => {
    fixture.getAgentContextUsage.mockResolvedValue({
      rawMaxTokens: 100,
      totalTokens: 60,
      percentage: 60,
      categories: [
        { id: "skills", name: "Skills from Claude", tokens: 20, kind: "used" },
        { id: "reserve", name: "Buffer", tokens: 10, kind: "buffer" },
        { id: "free", name: "Free", tokens: 30, kind: "free" },
        { id: "later", name: "Deferred", tokens: 200, kind: "deferred" },
      ],
      skills: [{ name: "review", source: "projectSettings", tokens: 12 }],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = () => (
      <QueryClientProvider client={queryClient}>
        <ContextWindowDetails
          serverId="host"
          agentId="agent"
          context={null}
          sessionCost={null}
          showTitle
          refreshable
        />
      </QueryClientProvider>
    );
    await act(async () => {
      root?.render(view());
    });
    expect(fixture.getAgentContextUsage).not.toHaveBeenCalled();

    fixture.supportsContextUsage = true;
    await act(async () => {
      root?.render(view());
    });
    expect(fixture.getAgentContextUsage).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container?.textContent).toContain("Skills from Claude");
    expect(container?.textContent).toContain("contextWindow.notInWindow");
    expect(container?.textContent).not.toContain("review");
    const row = container?.querySelector('[aria-label="Skills from Claude"]');
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      row?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    expect(container?.textContent).toContain("review");
    expect(container?.textContent).toContain("12 tokens");
    queryClient.clear();
  });
});
