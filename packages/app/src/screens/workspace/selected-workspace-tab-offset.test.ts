import { expect, it } from "vitest";
import { selectedWorkspaceTabOffset, workspaceTabRevealOffset } from "./workspace-tab-layout";

it("reveals the selected tab in an overflowing sidebar rail", () => {
  const tabs = [
    { width: 80, showLabel: true },
    { width: 110, showLabel: true },
    { width: 120, showLabel: true },
  ];
  expect(selectedWorkspaceTabOffset(tabs, 0, 2, 4)).toBe(0);
  expect(selectedWorkspaceTabOffset(tabs, 2, 2, 4)).toBe(198);
  expect(selectedWorkspaceTabOffset(tabs, -1, 2, 4)).toBe(0);
  expect(selectedWorkspaceTabOffset(tabs, 3, 2, 4)).toBe(0);
});

it("keeps visible tabs still and reveals clipped tabs by the smallest amount", () => {
  const rail = { scrollOffset: 100, viewportStart: 10, viewportEnd: 210 };
  expect(workspaceTabRevealOffset({ ...rail, tabStart: 30, tabEnd: 100 })).toBeNull();
  expect(workspaceTabRevealOffset({ ...rail, tabStart: 0, tabEnd: 70 })).toBe(90);
  expect(workspaceTabRevealOffset({ ...rail, tabStart: 180, tabEnd: 230 })).toBe(120);
  expect(workspaceTabRevealOffset({ ...rail, scrollOffset: 5, tabStart: 0, tabEnd: 70 })).toBe(0);
  expect(workspaceTabRevealOffset({ ...rail, tabStart: 40, tabEnd: 300 })).toBe(130);
  expect(workspaceTabRevealOffset({ ...rail, tabStart: 10, tabEnd: 300 })).toBeNull();
});
