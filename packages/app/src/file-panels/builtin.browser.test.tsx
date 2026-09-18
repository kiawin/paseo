import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { CsvPreview } from "./builtin";
import type { TextFilePreviewEditor } from "./source/panel";

// The unistyles test stub drops withUnistyles mappings, so the real Switch hands Reanimated
// undefined track colors, which Reanimated 4.5 rejects. The grid's toolbar renders one.
vi.mock("@/components/ui/switch", () => ({
  Switch: (props: { value: boolean; testID?: string }) =>
    React.createElement("button", {
      type: "button",
      role: "switch",
      "aria-checked": props.value,
      "data-testid": props.testID,
    }),
}));

beforeEach(() => vi.stubGlobal("React", React));

const HOST = { id: "host-under-test", label: "Host" };
const PARAMS = { path: "people.csv" };
const PEOPLE_CSV = "Name,City\nAda,London\nGrace,Paris";
const EDITOR: TextFilePreviewEditor = { edit: noop, save: noop, status: "clean", error: null };

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function setHostFeatures(features: { workspaceFileEditing?: boolean } | undefined): void {
  act(() =>
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [HOST.id]: { serverInfo: { features } } as unknown as (typeof state.sessions)[string],
      },
    })),
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
}

/** Mounts the panel's CSV preview with an editor and reports whether a pressed cell can be edited. */
async function pressedCellOpensAnEditor(): Promise<boolean> {
  const container = document.createElement("div");
  container.style.width = "640px";
  container.style.height = "420px";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() =>
    root.render(
      <CsvPreview
        text={PEOPLE_CSV}
        size={PEOPLE_CSV.length}
        params={PARAMS}
        workspaceId="workspace-under-test"
        host={HOST}
        editor={EDITOR}
      />,
    ),
  );
  await settle();
  const cell = container.querySelector('[data-testid="csv-cell-0-1"]');
  if (!(cell instanceof HTMLElement)) throw new Error("The grid did not render");
  act(() => cell.click());
  await settle();
  const opened = document.querySelector('[data-testid="csv-value-input"]') !== null;
  const readOnly = document.querySelector('[data-testid="csv-value-text"]') !== null;
  if (opened === readOnly) throw new Error("The value sheet did not open in exactly one mode");
  return opened;
}

describe("CSV panel preview", () => {
  it("hands the grid the editor only on a host that reports file editing", async () => {
    setHostFeatures({ workspaceFileEditing: true });
    expect(await pressedCellOpensAnEditor()).toBe(true);
  });

  it.each([
    ["reports it cannot edit files", { workspaceFileEditing: false }],
    ["predates the capability", {}],
    ["has sent no features", undefined],
  ])("stays read-only on a host that %s", async (_name, features) => {
    setHostFeatures(features);
    expect(await pressedCellOpensAnEditor()).toBe(false);
  });
});

function noop(): void {}
