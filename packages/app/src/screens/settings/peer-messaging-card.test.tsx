/** @vitest-environment jsdom */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { configState, patchConfigMock } = vi.hoisted(() => ({
  configState: {
    config: {
      agents: { peerMessaging: { enforceReachability: true, cwdReachability: false } },
    },
  },
  patchConfigMock: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    accessibilityLabel,
    testID,
  }: {
    value: boolean;
    onValueChange: (next: boolean) => void;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement("button", {
      type: "button",
      role: "switch",
      "aria-checked": value ? "true" : "false",
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      onClick: () => onValueChange(!value),
    }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: configState.config, patchConfig: patchConfigMock }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/styles/settings", () => ({
  settingsStyles: { card: {}, row: {}, rowContent: {}, rowTitle: {}, rowHint: {} },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PeerMessagingCards } from "./peer-messaging-card";

describe("PeerMessagingCards", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    patchConfigMock.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the current daemon values", () => {
    act(() => root.render(<PeerMessagingCards serverId="host-1" />));

    expect(
      document
        .querySelector("[data-testid='host-page-peer-messaging-enforce-switch']")
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      document
        .querySelector("[data-testid='host-page-peer-messaging-cwd-switch']")
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("patches each setting at its nested daemon config path", () => {
    act(() => root.render(<PeerMessagingCards serverId="host-1" />));

    act(() => {
      document
        .querySelector<HTMLButtonElement>("[data-testid='host-page-peer-messaging-enforce-switch']")
        ?.click();
      document
        .querySelector<HTMLButtonElement>("[data-testid='host-page-peer-messaging-cwd-switch']")
        ?.click();
    });

    expect(patchConfigMock).toHaveBeenNthCalledWith(1, {
      agents: { peerMessaging: { enforceReachability: false } },
    });
    expect(patchConfigMock).toHaveBeenNthCalledWith(2, {
      agents: { peerMessaging: { cwdReachability: true } },
    });
  });
});
