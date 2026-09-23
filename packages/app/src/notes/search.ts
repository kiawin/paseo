import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import type { FederatedNoteRecord, ProjectNoteHost } from "./federation";

type SearchClient = Pick<DaemonClient, "searchNotes">;

/**
 * What a text search across a project's hosts found. A host that searched is the authority for
 * its own notes; a host that could not (too old, offline, failed) falls back to titles.
 */
export interface NoteSearchOutcome {
  /** Keyed by `noteRowKey`; null when the title alone matched. */
  snippets: ReadonlyMap<string, string | null>;
  searchedServerIds: ReadonlySet<string>;
  failedServerIds: readonly string[];
}

export function normalizeNoteQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export function noteRowKey(note: Pick<FederatedNoteRecord, "serverId" | "noteId">): string {
  return `${note.serverId}:${note.noteId}`;
}

export async function searchProjectNotes(input: {
  hosts: readonly ProjectNoteHost[];
  query: string;
  searchSupportedByServerId: ReadonlyMap<string, boolean>;
  getClient: (serverId: string) => SearchClient | null;
}): Promise<NoteSearchOutcome> {
  const snippets = new Map<string, string | null>();
  const searchedServerIds = new Set<string>();
  const failedServerIds: string[] = [];
  await Promise.all(
    input.hosts.map(async (host) => {
      if (!input.searchSupportedByServerId.get(host.serverId)) return;
      const client = input.getClient(host.serverId);
      if (!client) {
        failedServerIds.push(host.serverId);
        return;
      }
      try {
        const matches = await client.searchNotes(host.projectId, input.query);
        for (const match of matches) {
          snippets.set(
            noteRowKey({ serverId: host.serverId, noteId: match.noteId }),
            match.snippet,
          );
        }
        searchedServerIds.add(host.serverId);
      } catch {
        failedServerIds.push(host.serverId);
      }
    }),
  );
  return { snippets, searchedServerIds, failedServerIds };
}

export function filterNotesBySearch(
  notes: readonly FederatedNoteRecord[],
  query: string,
  outcome: NoteSearchOutcome | null,
): FederatedNoteRecord[] {
  const terms = normalizeNoteQuery(query).split(" ").filter(Boolean);
  if (terms.length === 0) return [...notes];
  return notes.filter((note) => {
    if (outcome?.searchedServerIds.has(note.serverId)) {
      return outcome.snippets.has(noteRowKey(note));
    }
    const title = note.displayTitle.toLowerCase();
    return terms.every((term) => title.includes(term));
  });
}
