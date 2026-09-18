import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { TextFilePreviewEditor } from "@/file-panels/source/panel";
import { CsvEditSessionProvider, FileCsvPreview } from "./index";
import { CsvValueSheet, type CsvSheetCell, type CsvSheetDraft } from "./value-sheet";

// The unistyles test stub drops withUnistyles mappings, so the real Switch hands Reanimated
// undefined track colors, which Reanimated 4.5 rejects. These tests only need the toggle.
vi.mock("@/components/ui/switch", () => ({
  Switch: (props: {
    value: boolean;
    onValueChange?: (value: boolean) => void;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement("button", {
      type: "button",
      role: "switch",
      "aria-checked": props.value,
      "aria-label": props.accessibilityLabel,
      "data-testid": props.testID,
      onClick: () => props.onValueChange?.(!props.value),
    }),
}));

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

interface EditableGrid {
  container: HTMLDivElement;
  /** Every text the grid handed to the editor, oldest first. */
  edits: string[];
  saves: { count: number };
  /** The file changing outside the grid. */
  setContent(content: string): void;
  setSaveState(status: TextFilePreviewEditor["status"], error?: string): void;
  /** What a trip to Source and back does: the grid unmounts and mounts again in the same panel. */
  remountGrid(): void;
}

interface EditableGridControls {
  edits: string[];
  saves: { count: number };
  setContent(content: string): void;
  setSaveState(status: TextFilePreviewEditor["status"], error?: string): void;
  remountGrid(): void;
}

/** The grid inside a panel: the session outlives the grid, and edits come back as new content. */
const EditableGridHarness = React.forwardRef<
  EditableGridControls,
  { initialContent: string; filePath: string }
>(function EditableGridHarness({ initialContent, filePath }, ref) {
  const [content, setContent] = React.useState(initialContent);
  const [status, setStatus] = React.useState<TextFilePreviewEditor["status"]>("clean");
  const [error, setError] = React.useState<string | null>(null);
  const [gridKey, setGridKey] = React.useState(0);
  const [log] = React.useState(() => ({ edits: [] as string[], saves: { count: 0 } }));
  const editor = React.useMemo<TextFilePreviewEditor>(
    () => ({
      edit(text) {
        log.edits.push(text);
        setContent(text);
      },
      save() {
        log.saves.count += 1;
      },
      status,
      error,
    }),
    [error, log, status],
  );
  React.useImperativeHandle(
    ref,
    () => ({
      edits: log.edits,
      saves: log.saves,
      setContent,
      setSaveState(nextStatus, nextError) {
        setStatus(nextStatus);
        setError(nextError ?? null);
      },
      remountGrid() {
        setGridKey((key) => key + 1);
      },
    }),
    [log],
  );
  return (
    <CsvEditSessionProvider>
      <FileCsvPreview
        key={gridKey}
        filePath={filePath}
        content={content}
        size={content.length}
        editor={editor}
      />
    </CsvEditSessionProvider>
  );
});

function mountEditable(initialContent = PEOPLE_CSV, filePath = "people.csv"): EditableGrid {
  const controlsRef = React.createRef<EditableGridControls>();
  const container = mount(
    <EditableGridHarness ref={controlsRef} initialContent={initialContent} filePath={filePath} />,
  );
  const controls = controlsRef.current;
  if (!controls) throw new Error("The editable grid did not mount");

  return {
    container,
    edits: controls.edits,
    saves: controls.saves,
    setContent(content) {
      act(() => controls.setContent(content));
    },
    setSaveState(status, error) {
      act(() => controls.setSaveState(status, error));
    },
    remountGrid() {
      act(() => controls.remountGrid());
    },
  };
}

function find(testID: string): HTMLElement | null {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  return element instanceof HTMLElement ? element : null;
}

function valueInput(): HTMLTextAreaElement {
  const input = find("csv-value-input");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("The cell editor did not render");
  return input;
}

function setTextAreaValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
  );
}

async function typeIntoCell(container: HTMLElement, cellTestID: string, value: string) {
  click(container, cellTestID);
  await settle();
  act(() => setTextAreaValue(valueInput(), value));
  await settle();
}

async function editCell(container: HTMLElement, cellTestID: string, value: string) {
  await typeIntoCell(container, cellTestID, value);
  click(container, "csv-edit-save");
  await settle();
}

function isDisabled(testID: string): boolean {
  const element = find(testID);
  if (!element) throw new Error(`Missing ${testID}`);
  return element.getAttribute("aria-disabled") === "true" || element.hasAttribute("disabled");
}

describe("CSV cell editing", () => {
  it("stays read-only without an editor", async () => {
    const container = mount(preview());
    await settle();
    click(container, "csv-cell-0-1");
    await settle();

    expect(find("csv-value-text")?.textContent).toBe("London");
    expect(find("csv-value-input")).toBeNull();
    expect(find("csv-edit-save")).toBeNull();
    expect(find("csv-undo-edit")).toBeNull();
  });

  it("saves one cell into the editor buffer and shows it in the grid", async () => {
    const grid = mountEditable();
    await settle();

    click(grid.container, "csv-cell-0-1");
    await settle();
    expect(valueInput().value).toBe("London");
    expect(isDisabled("csv-edit-save")).toBe(true);

    act(() => setTextAreaValue(valueInput(), "Leeds, UK"));
    await settle();
    expect(isDisabled("csv-edit-save")).toBe(false);
    click(grid.container, "csv-edit-save");
    await settle();

    expect(grid.edits).toEqual(['Name,City\nAda,"Leeds, UK"\nGrace,Paris\nLin,London']);
    expect(find("csv-value-input")).toBeNull();
    expect(find("csv-cell-0-1")?.textContent).toBe("Leeds, UK");
    expect(find("csv-undo-edit")).not.toBeNull();
  });

  it("cancels without touching the buffer", async () => {
    const grid = mountEditable();
    await settle();
    await typeIntoCell(grid.container, "csv-cell-0-1", "Leeds");
    click(grid.container, "csv-edit-cancel");
    await settle();

    expect(grid.edits).toEqual([]);
    expect(find("csv-value-input")).toBeNull();
    expect(find("csv-cell-0-1")?.textContent).toBe("London");
  });

  it("keeps the typed text when the file changes and blocks the save until it changes back", async () => {
    const grid = mountEditable();
    await settle();
    await typeIntoCell(grid.container, "csv-cell-0-1", "Leeds");

    grid.setContent("Name,City\nNew,Row\nAda,London\nGrace,Paris\nLin,London");
    await settle();

    expect(valueInput().value).toBe("Leeds");
    expect(find("csv-edit-error")?.textContent).toBe("panels.file.csv.editChanged");
    expect(isDisabled("csv-edit-save")).toBe(true);
    click(grid.container, "csv-edit-save");
    await settle();
    expect(grid.edits).toEqual([]);

    grid.setContent(PEOPLE_CSV);
    await settle();
    expect(valueInput().value).toBe("Leeds");
    expect(find("csv-edit-error")).toBeNull();
    click(grid.container, "csv-edit-save");
    await settle();
    expect(grid.edits).toEqual(["Name,City\nAda,Leeds\nGrace,Paris\nLin,London"]);
  });

  it("keeps undo and the header mode across a trip to Source and back", async () => {
    const numbers = "1,2\n3,4\n5,6";
    const grid = mountEditable(numbers, "numbers.csv");
    await settle();
    expect(find("csv-first-row-header")?.getAttribute("aria-checked")).toBe("false");

    await editCell(grid.container, "csv-cell-0-0", "Name");
    expect(grid.edits).toEqual(["Name,2\n3,4\n5,6"]);
    expect(find("csv-first-row-header")?.getAttribute("aria-checked")).toBe("false");
    expect(find("csv-row-2")).not.toBeNull();

    grid.remountGrid();
    await settle();
    expect(find("csv-first-row-header")?.getAttribute("aria-checked")).toBe("false");
    expect(find("csv-row-2")).not.toBeNull();
    expect(find("csv-undo-edit")).not.toBeNull();

    click(grid.container, "csv-undo-edit");
    await settle();
    expect(grid.edits.at(-1)).toBe(numbers);
    expect(find("csv-undo-edit")).toBeNull();
  });

  it("drops undo when the buffer changed while the grid was away", async () => {
    const grid = mountEditable();
    await settle();
    await editCell(grid.container, "csv-cell-0-1", "Leeds");
    expect(find("csv-undo-edit")).not.toBeNull();

    grid.setContent("Name,City\nAda,Leeds\nGrace,Paris\nLin,Typed in Source");
    grid.remountGrid();
    await settle();

    expect(find("csv-undo-edit")).toBeNull();
  });

  it.each(["dirty", "saving", "clean", "conflict"] as const)(
    "undoes the latest edit while the save state is %s",
    async (status) => {
      const grid = mountEditable();
      await settle();
      await editCell(grid.container, "csv-cell-1-1", "Lyon");
      await editCell(grid.container, "csv-cell-0-0", 'A "d" a');
      const afterFirst = "Name,City\nAda,London\nGrace,Lyon\nLin,London";
      expect(grid.edits).toEqual([
        afterFirst,
        'Name,City\n"A ""d"" a",London\nGrace,Lyon\nLin,London',
      ]);

      grid.setSaveState(status);
      await settle();
      click(grid.container, "csv-undo-edit");
      await settle();
      expect(grid.edits.at(-1)).toBe(afterFirst);
      click(grid.container, "csv-undo-edit");
      await settle();
      expect(grid.edits.at(-1)).toBe(PEOPLE_CSV);
      expect(find("csv-undo-edit")).toBeNull();
    },
  );

  it("shows a failed save with its message and retries it", async () => {
    const grid = mountEditable();
    await settle();
    await editCell(grid.container, "csv-cell-0-1", "Leeds");
    expect(find("csv-save-failed")).toBeNull();

    grid.setSaveState("error", "File is too large to edit");
    await settle();
    expect(find("csv-save-failed")?.textContent).toContain("File is too large to edit");
    click(grid.container, "csv-save-retry");
    expect(grid.saves.count).toBe(1);

    grid.setSaveState("clean");
    await settle();
    expect(find("csv-save-failed")).toBeNull();
  });

  it("edits the row the user sees under a sort and a search, with and without a header row", async () => {
    const grid = mountEditable();
    await settle();
    click(grid.container, "csv-sort-0");
    await settle();
    click(grid.container, "csv-sort-0");
    await settle();
    const search = find("csv-search");
    if (!(search instanceof HTMLInputElement)) throw new Error("CSV search input did not render");
    act(() => setInputValue(search, "London"));
    await settle();
    const visible = [...grid.container.querySelectorAll('[data-testid^="csv-row-"]')].map((row) =>
      row.getAttribute("data-testid"),
    );
    expect(visible).toEqual(["csv-row-2", "csv-row-0"]);

    await editCell(grid.container, "csv-cell-2-1", "London, UK");
    expect(grid.edits.at(-1)).toBe('Name,City\nAda,London\nGrace,Paris\nLin,"London, UK"');

    click(grid.container, "csv-first-row-header");
    await settle();
    await editCell(grid.container, "csv-cell-1-1", "London, England");
    expect(grid.edits.at(-1)).toBe(
      'Name,City\nAda,"London, England"\nGrace,Paris\nLin,"London, UK"',
    );
  });

  it("rejects a tab in a TSV cell and keeps the sheet open with the typed text", async () => {
    const grid = mountEditable("Name\tCity\nAda\tLondon", "people.tsv");
    await settle();
    await editCell(grid.container, "csv-cell-0-1", "Lon\tdon");

    expect(grid.edits).toEqual([]);
    expect(find("csv-edit-error")?.textContent).toBe("panels.file.csv.editTsvCharacters");
    expect(valueInput().value).toBe("Lon\tdon");
  });

  it("saves text an input method is still composing", async () => {
    const grid = mountEditable();
    await settle();
    await typeIntoCell(grid.container, "csv-cell-0-1", "Le");
    const input = valueInput();
    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      setTextAreaValue(input, "Leeds");
    });
    await settle();

    click(grid.container, "csv-edit-save");
    await settle();
    expect(grid.edits).toEqual(["Name,City\nAda,Leeds\nGrace,Paris\nLin,London"]);
  });

  it("takes confirmed composition text once the input method commits it", async () => {
    const grid = mountEditable();
    await settle();
    click(grid.container, "csv-cell-0-1");
    await settle();
    const input = valueInput();

    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      setTextAreaValue(input, "Leeds");
    });
    await settle();
    expect(isDisabled("csv-edit-save")).toBe(true);

    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "Leeds" }));
    });
    await settle();
    expect(isDisabled("csv-edit-save")).toBe(false);
    click(grid.container, "csv-edit-save");
    await settle();
    expect(grid.edits).toEqual(["Name,City\nAda,Leeds\nGrace,Paris\nLin,London"]);
  });

  it("leaves the cell alone when a composition is cancelled", async () => {
    const grid = mountEditable();
    await settle();
    click(grid.container, "csv-cell-0-1");
    await settle();
    const input = valueInput();

    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      setTextAreaValue(input, "Leeds");
      setTextAreaValue(input, "London");
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    });
    await settle();

    expect(input.value).toBe("London");
    expect(isDisabled("csv-edit-save")).toBe(true);
    click(grid.container, "csv-edit-save");
    await settle();
    expect(grid.edits).toEqual([]);
    expect(find("csv-value-input")).not.toBeNull();
  });

  it("puts a line break in the value on Enter instead of submitting", async () => {
    const grid = mountEditable();
    await settle();
    await typeIntoCell(grid.container, "csv-cell-0-1", "Leeds");
    const input = valueInput();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    await userEvent.keyboard("{Enter}");
    await settle();

    expect(input.value).toBe("Leeds\n");
    expect(grid.edits).toEqual([]);
    expect(find("csv-value-input")).toBe(input);

    click(grid.container, "csv-edit-save");
    await settle();
    expect(grid.edits).toEqual(['Name,City\nAda,"Leeds\n"\nGrace,Paris\nLin,London']);
  });

  it("edits a file that holds a replacement character", async () => {
    const grid = mountEditable("Name,Note\nAda,odd \ufffd byte");
    await settle();
    await editCell(grid.container, "csv-cell-0-1", "fixed");

    expect(grid.edits).toEqual(["Name,Note\nAda,fixed"]);
  });
});

const SHEET_CELL: CsvSheetCell = {
  value: "London",
  columnName: "City",
  rowNumber: 2,
  rowValues: ["Ada", "London"],
};
const SHEET_VISIBLE_ROWS = [
  ["Ada", "London"],
  ["Grace", "Paris"],
];

interface SheetProbe {
  onClose: () => void;
  onSave: CsvSheetDraft["onSave"];
  write: (value: string) => Promise<void>;
}

/** The value sheet open on one editable cell. */
function SheetHarness({ onClose, onSave, write }: SheetProbe) {
  const draft = React.useMemo<CsvSheetDraft>(
    () => ({ key: 1, focusOnOpen: true, isStale: false, onSave }),
    [onSave],
  );
  return (
    <CsvValueSheet
      visible
      cell={SHEET_CELL}
      draft={draft}
      visibleRows={SHEET_VISIBLE_ROWS}
      autoCopyKind={null}
      onAutoCopyConsumed={noop}
      onClose={onClose}
      write={write}
    />
  );
}

/** The value sheet as a file without an editor shows it, which is every file on native. */
function ReadonlySheetHarness({ write }: Pick<SheetProbe, "write">) {
  return (
    <CsvValueSheet
      visible
      cell={SHEET_CELL}
      draft={null}
      visibleRows={SHEET_VISIBLE_ROWS}
      autoCopyKind={null}
      onAutoCopyConsumed={noop}
      onClose={noop}
      write={write}
    />
  );
}

function mountSheet(probe: SheetProbe): HTMLDivElement {
  return mount(<SheetHarness {...probe} />);
}

describe("CSV value sheet", () => {
  it("closes once on Escape and saves nothing", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(() => null);
    mountSheet({ onClose, onSave, write: vi.fn().mockResolvedValue(undefined) });
    await settle();
    act(() => setTextAreaValue(valueInput(), "Leeds"));
    await settle();
    valueInput().focus();

    await userEvent.keyboard("{Escape}");
    await settle();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("renders the read-only sheet with the value, the three copy actions and no editor", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const container = mount(<ReadonlySheetHarness write={write} />);
    await settle();

    expect(find("csv-value-text")?.textContent).toBe("London");
    for (const absent of [
      "csv-value-input",
      "csv-edit-save",
      "csv-edit-cancel",
      "csv-edit-error",
    ]) {
      expect(find(absent)).toBeNull();
    }
    const copyButtons = [...document.querySelectorAll('[data-testid^="csv-copy-"]')].map((button) =>
      button.getAttribute("data-testid"),
    );
    expect(copyButtons).toEqual(["csv-copy-cell", "csv-copy-row", "csv-copy-visible"]);

    click(container, "csv-copy-cell");
    await settle();
    expect(write).toHaveBeenLastCalledWith("London");
    click(container, "csv-copy-row");
    await settle();
    expect(write).toHaveBeenLastCalledWith("Ada\tLondon");
  });

  it("copies the text the sheet shows for the cell and the original row", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const container = mountSheet({ onClose: vi.fn(), onSave: vi.fn(() => null), write });
    await settle();

    click(container, "csv-copy-cell");
    await settle();
    expect(write).toHaveBeenLastCalledWith("London");

    act(() => setTextAreaValue(valueInput(), "Leeds"));
    await settle();
    click(container, "csv-copy-cell");
    await settle();
    expect(write).toHaveBeenLastCalledWith("Leeds");

    click(container, "csv-copy-row");
    await settle();
    expect(write).toHaveBeenLastCalledWith("Ada\tLondon");
    click(container, "csv-copy-visible");
    await settle();
    expect(write).toHaveBeenLastCalledWith("Ada\tLondon\nGrace\tParis");
  });
});

function noop(): void {}
