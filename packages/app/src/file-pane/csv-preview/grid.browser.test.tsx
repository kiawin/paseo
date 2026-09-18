import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CsvGrid } from "./grid";

beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];
const noop = () => undefined;
const SPIKE_GEOMETRY = {
  widths: [180, 180, 180, 180],
  totalWidth: 720,
  frozenWidth: 180,
  columnKinds: ["text", "text", "numeric", "text"] as const,
};

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "360px";
  container.style.height = "240px";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("CSV grid scroll spike", () => {
  it("translates body cells from a wheel-x event while column zero stays pinned", async () => {
    const container = mount(
      <CsvGrid
        headers={["id", "name", "notes", "status"]}
        headerMatches={[[], [], [], []]}
        rows={[
          {
            values: ["1", "Ada", "wide value", "ready"],
            originalIndex: 0,
            matches: [[], [], [], []],
          },
        ]}
        allRows={[["1", "Ada", "wide value", "ready"]]}
        geometry={SPIKE_GEOMETRY}
        sort={null}
        filters={new Map()}
        columnQueries={new Map()}
        onSort={noop}
        onFilterValuesChange={noop}
        onColumnQueryChange={noop}
        onSubstringFilterChange={noop}
        onCellPress={noop}
        onCopyRequest={noop}
      />,
    );

    const frozen = container.querySelector('[data-testid="csv-spike-header-cell-0"]');
    const body = container.querySelector('[data-testid="csv-spike-header-body"]');
    if (!(frozen instanceof HTMLElement) || !(body instanceof HTMLElement)) {
      throw new Error("CSV spike cells did not render");
    }
    const panSurface = container.firstElementChild;
    if (!(panSurface instanceof HTMLElement)) {
      throw new Error("CSV spike pan surface did not render");
    }

    const amountCell = container.querySelector('[data-testid="csv-cell-0-2"]');
    const nameCell = container.querySelector('[data-testid="csv-cell-0-1"]');
    const amountHeader = container.querySelector('[data-testid="csv-sort-2"]');
    const nameHeader = container.querySelector('[data-testid="csv-sort-1"]');
    if (
      !(amountCell instanceof HTMLElement) ||
      !(nameCell instanceof HTMLElement) ||
      !(amountHeader instanceof HTMLElement) ||
      !(nameHeader instanceof HTMLElement)
    ) {
      throw new Error("CSV alignment cells did not render");
    }
    expect(getComputedStyle(amountCell).textAlign).toBe("right");
    expect(getComputedStyle(nameCell).textAlign).toBe("left");
    expect(getComputedStyle(amountHeader).textAlign).toBe("right");
    expect(getComputedStyle(nameHeader).textAlign).toBe("left");

    await act(async () => {
      await nextFrame();
      await wait(50);
    });
    const frozenLeft = frozen.getBoundingClientRect().left;
    await act(async () => {
      panSurface.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaX: 200 }));
      await nextFrame();
      await wait(50);
    });

    expect(frozen.getBoundingClientRect().left).toBe(frozenLeft);
    // The wheel changes only the shared value; this transform is written by
    // Reanimated's web mapper, not by a React state mirror.
    expect(body.style.transform).toContain("-200px");

    const setPointerCapture = vi.spyOn(panSurface, "setPointerCapture");
    await act(async () => {
      panSurface.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 200,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
      panSurface.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 195,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
      expect(setPointerCapture).not.toHaveBeenCalled();
      panSurface.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 100,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
      panSurface.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: 100,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
      await nextFrame();
      await wait(50);
    });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(body.style.transform).toContain("-300px");
  });
});
