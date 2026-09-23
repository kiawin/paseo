import { describe, expect, test } from "vitest";
import {
  collectAllTabs,
  convertNoteDraftToNoteInLayout,
  stripEphemeralTabsFromLayout,
  type SplitPane,
  type WorkspaceLayout,
} from "./workspace-layout-actions";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";

function layoutWithNoteDraft(): WorkspaceLayout {
  const target = { kind: "note_draft" as const, serverId: "host-a", draftId: "draft-1" };
  return {
    root: {
      kind: "pane",
      pane: {
        id: "main",
        tabIds: ["provisional-tab"],
        focusedTabId: "provisional-tab",
        tabs: [{ tabId: "provisional-tab", target, createdAt: 1 }],
      } as SplitPane,
    },
    focusedPaneId: "main",
  };
}

describe("note draft workspace conversion", () => {
  test("replaces the provisional tab with the canonical note identity", () => {
    const result = convertNoteDraftToNoteInLayout({
      layout: layoutWithNoteDraft(),
      tabId: "provisional-tab",
      serverId: "host-a",
      noteId: "note-1",
    });

    expect(result?.tabId).toBe(
      buildDeterministicWorkspaceTabId({ kind: "note", serverId: "host-a", noteId: "note-1" }),
    );
    if (!result) throw new Error("Expected note draft conversion");
    expect(collectAllTabs(result.layout.root)).toMatchObject([
      {
        tabId: "note_6_host-a_6_note-1",
        target: { kind: "note", serverId: "host-a", noteId: "note-1" },
      },
    ]);
  });

  test("strips unsaved note drafts before layout persistence", () => {
    const persisted = stripEphemeralTabsFromLayout(layoutWithNoteDraft());

    expect(collectAllTabs(persisted.root).some((tab) => tab.target.kind === "note_draft")).toBe(
      false,
    );
  });
});
