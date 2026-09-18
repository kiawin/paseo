import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileCsvPreview } from "./index";

beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "640px";
  container.style.height = "420px";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settle(): Promise<void> {
  await act(async () => {
    await wait(180);
  });
}

function click(container: HTMLElement, testID: string): void {
  const element =
    container.querySelector(`[data-testid="${testID}"]`) ??
    document.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${testID}`);
  act(() => element.click());
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
  );
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const PEOPLE_CSV = "Name,City\nAda,London\nGrace,Paris\nLin,London";

function preview(content = PEOPLE_CSV) {
  return <FileCsvPreview filePath="people.csv" content={content} size={content.length} />;
}

describe("CSV preview browser behavior", () => {
  it("searches rows and keeps every row for a header-only match", async () => {
    const container = mount(preview());
    await settle();

    const search = container.querySelector('[data-testid="csv-search"]');
    if (!(search instanceof HTMLInputElement)) throw new Error("CSV search input did not render");
    act(() => setInputValue(search, "city"));
    await settle();
    expect(container.querySelector('[data-testid="csv-row-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="csv-row-2"]')).not.toBeNull();

    const filtered = mount(preview());
    await settle();
    const filteredSearch = filtered.querySelector('[data-testid="csv-search"]');
    if (!(filteredSearch instanceof HTMLInputElement))
      throw new Error("filtered search did not render");
    act(() => setInputValue(filteredSearch, "Paris"));
    await settle();
    expect(filtered.querySelector('[data-testid="csv-row-0"]')).toBeNull();
    expect(filtered.textContent).toContain("Grace");
  });

  it("keeps the column filter menu open while a value is unticked", async () => {
    const container = mount(preview());
    await settle();
    click(container, "csv-filter-1");
    await settle();
    expect(document.querySelector('[data-testid="csv-filter-menu-1"]')).not.toBeNull();
    click(container, "csv-filter-value-1-London");
    await settle();
    expect(document.querySelector('[data-testid="csv-filter-menu-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="csv-row-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="csv-row-0"]')).not.toBeNull();
  });

  it("cycles a header sort and lets the header switch move row one into the body", async () => {
    const container = mount(preview());
    await settle();
    click(container, "csv-sort-0");
    await settle();
    const rows = [...container.querySelectorAll('[data-testid^="csv-row-"]')];
    expect(rows[0]?.textContent).toContain("Ada");

    const headerless = mount(preview("1,2\n3,4"));
    await settle();
    expect(headerless.querySelector('[data-testid="csv-row-0"]')?.textContent).toContain("1");
    click(headerless, "csv-first-row-header");
    await settle();
    expect(headerless.querySelector('[data-testid="csv-row-0"]')?.textContent).toContain("3");
  });

  it("renders ragged-row navigation and copy success and failure states", async () => {
    const container = mount(preview("Name,City\nAda,London\nGrace"));
    await settle();
    expect(container.querySelector('[data-testid="csv-ragged-banner"]')).not.toBeNull();
    click(container, "csv-ragged-jump");

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    click(container, "csv-cell-0-1");
    await settle();
    click(container, "csv-copy-cell");
    await settle();
    expect(document.body.textContent).toContain("panels.file.csv.copySuccess");

    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    click(container, "csv-copy-cell");
    await settle();
    expect(document.body.textContent).toContain("panels.file.csv.copyFailed");
  });
});
