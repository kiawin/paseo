import { describe, expect, it } from "vitest";
import type { NoteRecordPayload } from "@getpaseo/protocol/messages";

import { panelResourceKey } from "@/panels/panel-manifest";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import {
  fetchFederatedProjectNotes,
  groupFederatedNotesByHost,
  noteTargetForRow,
  resolveProjectNoteHosts,
  type NotesRuntime,
  type ProjectNoteHost,
} from "./federation";
import type { NoteMetadataOwner } from "./replica";

const HOSTS: ProjectNoteHost[] = [
  { serverId: "host-a", projectId: "project-a", serverName: "Alpha" },
  { serverId: "host-b", projectId: "project-b", serverName: "Beta" },
];

function note(noteId: string, projectId: string, title: string): NoteRecordPayload {
  return {
    noteId,
    projectId,
    displayTitle: title,
    size: title.length,
    contentSha256: `sha-${noteId}`,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    revision: 1,
  };
}

function runtime(input: {
  statuses: Record<string, string>;
  notes?: Record<string, NoteRecordPayload[]>;
  cachedNotes?: Record<string, NoteRecordPayload[]>;
  failures?: Set<string>;
}): NotesRuntime {
  const owners = new Map<string, NoteMetadataOwner>();
  return {
    getSnapshot: (serverId) => ({ connectionStatus: input.statuses[serverId] ?? "offline" }),
    getClient: (serverId) => {
      if (input.statuses[serverId] !== "online") return null;
      return {
        listNotes: async (projectId: string) => {
          if (input.failures?.has(serverId)) throw new Error("unreachable");
          return input.notes?.[projectId] ?? [];
        },
      };
    },
    getNoteMetadataOwner: (serverId) => {
      const existing = owners.get(serverId);
      if (existing) return existing;
      const owner: NoteMetadataOwner = {
        connectionChanged: () => false,
        acquire: () => () => undefined,
        list: async (projectId) => {
          if (input.failures?.has(serverId)) throw new Error("unreachable");
          return input.statuses[serverId] === "online"
            ? (input.notes?.[projectId] ?? [])
            : (input.cachedNotes?.[projectId] ?? []);
        },
        hydrate: async (projectId) => input.notes?.[projectId] ?? [],
        replace: async (projectId) => input.notes?.[projectId] ?? [],
        repair: async (projectId) => input.notes?.[projectId] ?? [],
        delete: () => undefined,
        subscribe: () => () => undefined,
        dispose: () => undefined,
      };
      owners.set(serverId, owner);
      return owner;
    },
  };
}

describe("federated project notes", () => {
  it("fans out over grouped host placements into one host-tagged list", async () => {
    const result = await fetchFederatedProjectNotes({
      hosts: HOSTS,
      runtime: runtime({
        statuses: { "host-a": "online", "host-b": "online" },
        notes: {
          "project-a": [note("note-a", "project-a", "Alpha note")],
          "project-b": [note("note-b", "project-b", "Beta note")],
        },
      }),
      supportedByServerId: new Map([
        ["host-a", true],
        ["host-b", true],
      ]),
    });

    expect(result).toMatchObject({ status: "loaded", hostErrors: [] });
    if (result.status !== "loaded") return;
    expect(result.notes.map((item) => [item.serverId, item.noteId, item.serverName])).toEqual([
      ["host-a", "note-a", "Alpha"],
      ["host-b", "note-b", "Beta"],
    ]);
    expect(groupFederatedNotesByHost(result.notes).map((group) => group.serverId)).toEqual([
      "host-a",
      "host-b",
    ]);
  });

  it("keeps cached metadata for an offline host beside reachable notes", async () => {
    const result = await fetchFederatedProjectNotes({
      hosts: HOSTS,
      runtime: runtime({
        statuses: { "host-a": "offline", "host-b": "online" },
        notes: { "project-b": [note("note-b", "project-b", "Beta note")] },
        cachedNotes: { "project-a": [note("note-a", "project-a", "Cached note")] },
      }),
      supportedByServerId: new Map([
        ["host-a", true],
        ["host-b", true],
      ]),
    });

    expect(result).toMatchObject({
      status: "loaded",
      notes: [
        expect.objectContaining({ serverId: "host-a", noteId: "note-a" }),
        expect.objectContaining({ serverId: "host-b", noteId: "note-b" }),
      ],
      hostErrors: [{ serverId: "host-a", reason: "unreachable" }],
    });
  });

  it("reports a failed host without rejecting the successful host", async () => {
    const result = await fetchFederatedProjectNotes({
      hosts: HOSTS,
      runtime: runtime({
        statuses: { "host-a": "online", "host-b": "online" },
        notes: { "project-a": [note("note-a", "project-a", "Alpha note")] },
        failures: new Set(["host-b"]),
      }),
    });

    expect(result).toMatchObject({
      status: "loaded",
      notes: [expect.objectContaining({ serverId: "host-a", noteId: "note-a" })],
      hostErrors: [{ serverId: "host-b", reason: "failed" }],
    });
  });

  it("does not federate a no-remote project across hosts", () => {
    const hosts = resolveProjectNoteHosts({
      projects: [
        {
          viewKey: "placement-a",
          projectKey: null,
          projectName: "app",
          projectKind: "git",
          iconWorkingDir: "/a/app",
          hosts: [
            {
              serverId: "host-a",
              projectId: "project-a",
              iconWorkingDir: "/a/app",
              worktreeSupport: "supported",
            },
          ],
          workspaceKeys: ["host-a:workspace-a"],
        },
        {
          viewKey: "placement-b",
          projectKey: null,
          projectName: "app",
          projectKind: "git",
          iconWorkingDir: "/b/app",
          hosts: [
            {
              serverId: "host-b",
              projectId: "project-b",
              iconWorkingDir: "/b/app",
              worktreeSupport: "supported",
            },
          ],
          workspaceKeys: ["host-b:workspace-b"],
        },
      ],
      anchorServerId: "host-a",
      workspaceId: "workspace-a",
      fallbackProjectId: "project-a",
      hostNames: new Map([
        ["host-a", "Alpha"],
        ["host-b", "Beta"],
      ]),
    });

    expect(hosts).toEqual([{ serverId: "host-a", projectId: "project-a", serverName: "Alpha" }]);
  });

  it("exposes a missing structure placement when no project fallback is available", () => {
    expect(
      resolveProjectNoteHosts({
        projects: [],
        anchorServerId: "host-a",
        workspaceId: "rebuilt-workspace",
        fallbackProjectId: null,
        hostNames: new Map([["host-a", "Alpha"]]),
      }),
    ).toEqual([]);
  });

  it("keeps same-id notes distinct by origin host in targets, tabs, and resources", () => {
    const hostANote = noteTargetForRow({ serverId: "host-a", noteId: "same-id" });
    const hostBNote = noteTargetForRow({ serverId: "host-b", noteId: "same-id" });

    expect(hostANote).toEqual({ kind: "note", serverId: "host-a", noteId: "same-id" });
    expect(buildDeterministicWorkspaceTabId(hostANote)).not.toBe(
      buildDeterministicWorkspaceTabId(hostBNote),
    );
    expect(panelResourceKey(hostANote)).not.toBe(panelResourceKey(hostBNote));
  });
});
