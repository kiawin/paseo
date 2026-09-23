import type { ProjectNoteHost } from "./federation";

const NOTES_QUERY_PREFIX = ["notes"] as const;

export function notesQueryKey(serverId: string, projectId: string | null) {
  return [...NOTES_QUERY_PREFIX, serverId, projectId] as const;
}

export function noteQueryKey(serverId: string, noteId: string, projectId: string | null) {
  return [...NOTES_QUERY_PREFIX, "record", serverId, noteId, projectId] as const;
}

export function federatedNotesQueryKey(hosts: readonly ProjectNoteHost[]) {
  const hostKeys = hosts
    .map((host) => [host.serverId, host.projectId] as const)
    .sort(
      ([leftServerId, leftProjectId], [rightServerId, rightProjectId]) =>
        leftServerId.localeCompare(rightServerId) || leftProjectId.localeCompare(rightProjectId),
    );
  return [...NOTES_QUERY_PREFIX, "project", hostKeys] as const;
}
