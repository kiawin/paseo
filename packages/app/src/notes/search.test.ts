import { describe, expect, test } from "vitest";

import type { FederatedNoteRecord, ProjectNoteHost } from "./federation";
import { filterNotesBySearch, searchProjectNotes } from "./search";

function note(serverId: string, noteId: string, displayTitle: string): FederatedNoteRecord {
  return {
    noteId,
    projectId: `prj_${serverId}`,
    displayTitle,
    size: 1,
    contentSha256: noteId,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 1,
    serverId,
    serverName: serverId,
  };
}

const HOSTS: ProjectNoteHost[] = [
  { serverId: "new", projectId: "prj_new", serverName: "new" },
  { serverId: "old", projectId: "prj_old", serverName: "old" },
  { serverId: "down", projectId: "prj_down", serverName: "down" },
];

const NOTES = [
  note("new", "n1", "Standup"),
  note("new", "n2", "Release plan"),
  note("old", "o1", "Release checklist"),
  note("old", "o2", "Retro"),
  note("down", "d1", "Release blockers"),
  note("down", "d2", "Hiring"),
];

describe("note search", () => {
  test("text search decides for hosts that ran it, titles decide for the rest", async () => {
    const outcome = await searchProjectNotes({
      hosts: HOSTS,
      query: "release",
      searchSupportedByServerId: new Map([
        ["new", true],
        ["old", false],
        ["down", true],
      ]),
      getClient: (serverId) => {
        if (serverId === "new") {
          return {
            searchNotes: async (projectId: string) => {
              expect(projectId).toBe("prj_new");
              return [
                { noteId: "n1", snippet: "…the release moved…" },
                { noteId: "n2", snippet: null },
              ];
            },
          };
        }
        return {
          searchNotes: async () => {
            throw new Error("socket closed");
          },
        };
      },
    });

    expect(outcome.failedServerIds).toEqual(["down"]);
    expect(outcome.snippets.get("new:n1")).toBe("…the release moved…");
    // "new" searched body text, so "Standup" is in on its body; "old" is too old and "down"
    // failed, so both fall back to titles.
    expect(filterNotesBySearch(NOTES, "  Release ", outcome).map((n) => n.noteId)).toEqual([
      "n1",
      "n2",
      "o1",
      "d1",
    ]);
  });

  test("an empty query keeps every note, and no outcome yet means titles only", () => {
    expect(filterNotesBySearch(NOTES, "   ", null)).toHaveLength(NOTES.length);
    expect(filterNotesBySearch(NOTES, "release plan", null).map((n) => n.noteId)).toEqual(["n2"]);
  });
});
