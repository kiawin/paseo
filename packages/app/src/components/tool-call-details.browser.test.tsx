import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { ToolCallDetailsContent } from "./tool-call-details";

void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * The expanded trace row sits inside the transcript, so a card that scrolls on its own is a
 * scroller inside a scroller. `fullExpand` has to leave every card at its natural size and wrap
 * its text; this measures that in a real layout engine, in a column narrow enough to force it.
 */

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const LONG_LINE = `${"averyveryverylongunbrokentoken".repeat(12)} and some words after it`;
const MANY_LINES = Array.from({ length: 60 }, (_, index) => `line ${index} ${LONG_LINE}`).join(
  "\n",
);

const DETAILS: Record<string, ToolCallDetail> = {
  shell: { type: "shell", command: `echo ${LONG_LINE}`, output: MANY_LINES },
  edit: {
    type: "edit",
    filePath: "src/a.ts",
    oldString: MANY_LINES,
    newString: MANY_LINES.replaceAll("line", "LINE"),
  },
  read: { type: "read", filePath: "src/a.ts", content: MANY_LINES },
  write: { type: "write", filePath: "src/a.ts", content: MANY_LINES },
  fetch: { type: "fetch", url: "https://example.com", result: MANY_LINES },
  search: { type: "search", query: "q", content: MANY_LINES },
  unknown: { type: "unknown", input: { text: MANY_LINES }, output: null },
};

function mount(detail: ToolCallDetail, fullExpand: boolean, errorText?: string): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "420px";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ToolCallDetailsContent
        detail={detail}
        maxHeight={200}
        fullExpand={fullExpand}
        errorText={errorText}
      />,
    ),
  );
  mounted.push({ root, container });
  return container;
}

function scrollersWithOverflow(container: HTMLElement): string[] {
  const offenders: string[] = [];
  for (const element of container.querySelectorAll<HTMLElement>("*")) {
    const style = getComputedStyle(element);
    const scrollsX =
      /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
    const scrollsY =
      /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    if (scrollsX || scrollsY)
      offenders.push(`${element.tagName}${scrollsX ? " x" : ""}${scrollsY ? " y" : ""}`);
  }
  return offenders;
}

describe("ToolCallDetailsContent fullExpand", () => {
  for (const [name, detail] of Object.entries(DETAILS)) {
    it(`${name}: no scrollbars, nothing wider than the column`, () => {
      const container = mount(detail, true, name === "shell" ? LONG_LINE : undefined);
      expect(container.textContent).toContain("line 59");
      expect(scrollersWithOverflow(container)).toEqual([]);
      expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
    });
  }

  it("control: without fullExpand the same card does scroll", () => {
    const container = mount(DETAILS.read, false);
    expect(scrollersWithOverflow(container).length).toBeGreaterThan(0);
  });
});
