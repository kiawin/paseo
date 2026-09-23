import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { NoteRecordPayload } from "@getpaseo/protocol/messages";

import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import type { NoteMetadataOwner } from "./replica";

export interface ProjectNoteHost {
  serverId: string;
  projectId: string;
  serverName: string;
}

export interface FederatedNoteRecord extends NoteRecordPayload {
  serverId: string;
  serverName: string;
}

export interface NoteTarget {
  kind: "note";
  serverId: string;
  noteId: string;
}

export interface NoteHostError {
  serverId: string;
  serverName: string;
  reason: "unreachable" | "unsupported" | "failed";
}

export interface NotesRuntimeSnapshot {
  connectionStatus: string;
}

export interface NotesRuntime {
  getClient(serverId: string): Pick<DaemonClient, "listNotes"> | null;
  getNoteMetadataOwner(serverId: string): NoteMetadataOwner | null;
  getSnapshot(serverId: string): NotesRuntimeSnapshot | null;
}

export interface FetchFederatedProjectNotesInput {
  hosts: readonly ProjectNoteHost[];
  runtime: NotesRuntime;
  supportedByServerId?: ReadonlyMap<string, boolean | null>;
}

export type FetchFederatedProjectNotesResult =
  | { status: "connecting" }
  | {
      status: "loaded";
      notes: FederatedNoteRecord[];
      hostErrors: NoteHostError[];
    };

export async function fetchFederatedProjectNotes(
  input: FetchFederatedProjectNotesInput,
): Promise<FetchFederatedProjectNotesResult> {
  const hasSettlingHost = input.hosts.some((host) => {
    const snapshot = input.runtime.getSnapshot(host.serverId);
    return snapshot === null || isConnectionSettling(snapshot.connectionStatus);
  });

  const results = await Promise.all(
    input.hosts.map(async (host) => {
      const supported = input.supportedByServerId?.get(host.serverId);
      if (supported === false) {
        return {
          notes: [],
          hostError: { ...hostErrorFor(host), reason: "unsupported" as const },
        };
      }

      const snapshot = input.runtime.getSnapshot(host.serverId);
      if (snapshot === null || isConnectionSettling(snapshot.connectionStatus)) {
        return null;
      }

      const owner = input.runtime.getNoteMetadataOwner(host.serverId);
      if (!owner) {
        return {
          notes: [],
          hostError: { ...hostErrorFor(host), reason: "failed" as const },
        };
      }
      try {
        const notes = await owner.list(host.projectId);
        return {
          notes: notes.map((note) =>
            Object.assign({}, note, {
              serverId: host.serverId,
              serverName: host.serverName,
            }),
          ),
          hostError: snapshot.connectionStatus === "online" ? null : hostErrorFor(host),
        };
      } catch {
        return {
          notes: [],
          hostError: { ...hostErrorFor(host), reason: "failed" as const },
        };
      }
    }),
  );

  if (results.every((result) => result === null) && hasSettlingHost) {
    return { status: "connecting" };
  }

  return {
    status: "loaded",
    notes: results.flatMap((result) => result?.notes ?? []),
    hostErrors: results.flatMap((result) => (result?.hostError ? [result.hostError] : [])),
  };
}

export function resolveProjectNoteHosts(input: {
  projects: readonly WorkspaceStructureProject[];
  anchorServerId: string;
  workspaceId: string | null;
  fallbackProjectId: string | null;
  hostNames: ReadonlyMap<string, string>;
}): ProjectNoteHost[] {
  const workspaceKey = input.workspaceId ? `${input.anchorServerId}:${input.workspaceId}` : null;
  const groupedProject = workspaceKey
    ? input.projects.find((project) => project.workspaceKeys.includes(workspaceKey))
    : undefined;

  if (groupedProject) {
    return groupedProject.hosts.map((host) => ({
      serverId: host.serverId,
      projectId: host.projectId,
      serverName: input.hostNames.get(host.serverId) ?? host.serverId,
    }));
  }

  if (!input.fallbackProjectId) {
    return [];
  }

  return [
    {
      serverId: input.anchorServerId,
      projectId: input.fallbackProjectId,
      serverName: input.hostNames.get(input.anchorServerId) ?? input.anchorServerId,
    },
  ];
}

export function noteTargetForRow(
  note: Pick<FederatedNoteRecord, "serverId" | "noteId">,
): NoteTarget {
  return {
    kind: "note",
    serverId: note.serverId,
    noteId: note.noteId,
  };
}

export function groupFederatedNotesByHost(
  notes: readonly FederatedNoteRecord[],
): Array<{ serverId: string; serverName: string; notes: FederatedNoteRecord[] }> {
  const groups: Array<{ serverId: string; serverName: string; notes: FederatedNoteRecord[] }> = [];
  for (const note of notes) {
    const previous = groups.at(-1);
    if (previous?.serverId === note.serverId) {
      previous.notes.push(note);
      continue;
    }
    groups.push({ serverId: note.serverId, serverName: note.serverName, notes: [note] });
  }
  return groups;
}

function isConnectionSettling(status: string): boolean {
  return status === "idle" || status === "connecting";
}

function hostErrorFor(host: ProjectNoteHost): NoteHostError {
  return {
    serverId: host.serverId,
    serverName: host.serverName,
    reason: "unreachable",
  };
}
