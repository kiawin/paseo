import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { NoteRecordPayload } from "@getpaseo/protocol/messages";

import type { CachedNoteMetadataRead, ReplicaCache } from "@/runtime/replica-cache";

export interface NoteMetadataReplicaStorage {
  readNoteMetadata(serverId: string): Promise<CachedNoteMetadataRead>;
  replaceNoteMetadata(
    serverId: string,
    projectId: string,
    notes: readonly NoteRecordPayload[],
  ): void;
  deleteNoteMetadata(serverId: string, noteId: string): void;
}

type NoteMetadataClient = Pick<DaemonClient, "listNotes" | "observeNoteChanges">;

export type NoteMetadataDemandKind = "list" | "note";

export interface NoteMetadataReplicaConnection {
  client: NoteMetadataClient | null;
  status: "online" | "offline";
  supported: boolean | null;
  source: { clientGeneration: number; connectionEpoch: number };
}

export interface NoteMetadataReplica {
  connectionChanged(connection: NoteMetadataReplicaConnection): boolean;
  acquire(projectId: string, kind: NoteMetadataDemandKind): () => void;
  list(projectId: string): Promise<NoteRecordPayload[]>;
  hydrate(projectId: string): Promise<NoteRecordPayload[]>;
  replace(projectId: string): Promise<NoteRecordPayload[]>;
  repair(projectId: string): Promise<NoteRecordPayload[]>;
  delete(projectId: string, noteId: string): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export type NoteMetadataOwner = NoteMetadataReplica;

interface ProjectState {
  notes: NoteRecordPayload[];
  hydrated: boolean;
  cacheInvalid: boolean;
  requestVersion: number;
}

const emptyProjectState = (): ProjectState => ({
  notes: [],
  hydrated: false,
  cacheInvalid: false,
  requestVersion: 0,
});

function metadataOnly(note: NoteRecordPayload): NoteRecordPayload {
  return {
    noteId: note.noteId,
    projectId: note.projectId,
    displayTitle: note.displayTitle,
    size: note.size,
    contentSha256: note.contentSha256,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revision: note.revision,
  };
}

class NoteMetadataReplicaOwner implements NoteMetadataReplica {
  private connection: NoteMetadataReplicaConnection = {
    client: null,
    status: "offline",
    supported: null,
    source: { clientGeneration: 0, connectionEpoch: 0 },
  };
  private readonly projects = new Map<string, ProjectState>();
  private readonly demandedProjects = new Map<string, { list: number; note: number }>();
  private readonly listeners = new Set<() => void>();
  private eventSubscription: ReturnType<DaemonClient["observeNoteChanges"]> | null = null;
  private cacheRead: Promise<CachedNoteMetadataRead> | null = null;
  private cacheReadVersion = -1;
  private stateVersion = 0;
  private disposed = false;

  constructor(
    private readonly serverId: string,
    private readonly storage: NoteMetadataReplicaStorage,
  ) {}

  connectionChanged(connection: NoteMetadataReplicaConnection): boolean {
    const changed =
      this.connection.client !== connection.client ||
      this.connection.status !== connection.status ||
      this.connection.supported !== connection.supported ||
      this.connection.source.clientGeneration !== connection.source.clientGeneration ||
      this.connection.source.connectionEpoch !== connection.source.connectionEpoch;
    if (!changed) return false;

    this.releaseEventSubscription();
    this.connection = connection;
    if (connection.status !== "online" || !connection.client || connection.supported !== true) {
      return true;
    }

    this.ensureEventSubscription();
    for (const [projectId, demand] of this.demandedProjects) {
      if (demand.list === 0) continue;
      void this.replace(projectId).catch(() => undefined);
    }
    return true;
  }

  acquire(projectId: string, kind: NoteMetadataDemandKind): () => void {
    if (this.disposed) return () => undefined;
    const demand = this.demandedProjects.get(projectId) ?? { list: 0, note: 0 };
    demand[kind] += 1;
    this.demandedProjects.set(projectId, demand);
    this.ensureEventSubscription();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.demandedProjects.get(projectId);
      if (!current) return;
      current[kind] -= 1;
      if (current.list === 0 && current.note === 0) this.demandedProjects.delete(projectId);
      if (this.demandedProjects.size === 0) this.releaseEventSubscription();
    };
  }

  async list(projectId: string): Promise<NoteRecordPayload[]> {
    await this.hydrate(projectId);
    const state = this.stateFor(projectId);
    if (
      this.connection.status !== "online" ||
      !this.connection.client ||
      this.connection.supported !== true
    ) {
      return state.notes.map(metadataOnly);
    }
    return state.cacheInvalid ? this.repair(projectId) : this.replace(projectId);
  }

  async hydrate(projectId: string): Promise<NoteRecordPayload[]> {
    const state = this.stateFor(projectId);
    if (state.hydrated) return state.notes.map(metadataOnly);

    const readVersion = this.stateVersion;
    let cached: CachedNoteMetadataRead;
    try {
      cached = await this.readCache(readVersion);
    } catch {
      // A storage failure is retryable. Do not turn a transient read error into a hydrated empty
      // cache, otherwise an offline session has no later event or connection transition that can
      // advance stateVersion and clear the rejected read.
      state.cacheInvalid = true;
      state.hydrated = false;
      return state.notes.map(metadataOnly);
    }

    // A live event or accepted network result won while storage was reading. The cache result is
    // stale and must not roll the owner back.
    if (readVersion !== this.stateVersion || this.disposed) {
      return state.notes.map(metadataOnly);
    }

    state.hydrated = true;
    state.cacheInvalid = cached.hasInvalidRows;
    state.notes = cached.notes.filter((note) => note.projectId === projectId).map(metadataOnly);
    this.publish();
    return state.notes.map(metadataOnly);
  }

  async replace(projectId: string): Promise<NoteRecordPayload[]> {
    const state = this.stateFor(projectId);
    const { client, source } = this.connection;
    if (this.connection.status !== "online" || !client || this.connection.supported !== true) {
      return state.notes.map(metadataOnly);
    }

    const requestVersion = ++state.requestVersion;
    const notes = await client.listNotes(projectId);
    if (!this.isCurrent(client, source) || requestVersion !== state.requestVersion) {
      return state.notes.map(metadataOnly);
    }

    const accepted = notes.map(metadataOnly);
    state.hydrated = true;
    state.cacheInvalid = false;
    state.notes = accepted;
    this.stateVersion += 1;
    this.storage.replaceNoteMetadata(this.serverId, projectId, accepted);
    this.publish();
    return accepted.map(metadataOnly);
  }

  async repair(projectId: string): Promise<NoteRecordPayload[]> {
    if (
      this.connection.status !== "online" ||
      !this.connection.client ||
      this.connection.supported !== true
    ) {
      return this.stateFor(projectId).notes.map(metadataOnly);
    }
    return this.replace(projectId);
  }

  delete(projectId: string, noteId: string): void {
    const state = this.stateFor(projectId);
    state.hydrated = true;
    state.cacheInvalid = false;
    state.requestVersion += 1;
    state.notes = state.notes.filter((note) => note.noteId !== noteId);
    this.stateVersion += 1;
    this.storage.deleteNoteMetadata(this.serverId, noteId);
    this.publish();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseEventSubscription();
    this.demandedProjects.clear();
    this.listeners.clear();
  }

  private stateFor(projectId: string): ProjectState {
    const existing = this.projects.get(projectId);
    if (existing) return existing;
    const state = emptyProjectState();
    this.projects.set(projectId, state);
    return state;
  }

  private readCache(readVersion: number): Promise<CachedNoteMetadataRead> {
    if (!this.cacheRead || this.cacheReadVersion !== readVersion) {
      this.cacheReadVersion = readVersion;
      const read = this.storage.readNoteMetadata(this.serverId);
      this.cacheRead = read.catch((error: unknown) => {
        if (this.cacheReadVersion === readVersion) this.cacheRead = null;
        throw error;
      });
    }
    return this.cacheRead;
  }

  private ensureEventSubscription(): void {
    if (
      this.disposed ||
      this.eventSubscription ||
      this.connection.status !== "online" ||
      !this.connection.client ||
      this.connection.supported !== true ||
      this.demandedProjects.size === 0
    ) {
      return;
    }

    const client = this.connection.client;
    const source = this.connection.source;
    const subscription = client.observeNoteChanges();
    this.eventSubscription = subscription;
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (!this.isCurrent(client, source) || message.type !== "note.changed") return;
        const { projectId, noteId, kind } = message.payload;
        if (!this.demandedProjects.has(projectId)) return;
        if (kind === "delete") {
          this.delete(projectId, noteId);
        } else {
          void this.replace(projectId).catch(() => undefined);
        }
      },
    });
    void subscription.ready.catch(() => {
      if (this.eventSubscription !== subscription) return;
      this.eventSubscription = null;
      void subscription.release().catch(() => undefined);
    });
  }

  private releaseEventSubscription(): void {
    const subscription = this.eventSubscription;
    this.eventSubscription = null;
    void subscription?.release().catch(() => undefined);
  }

  private isCurrent(
    client: NoteMetadataClient,
    source: NoteMetadataReplicaConnection["source"],
  ): boolean {
    return (
      !this.disposed &&
      this.connection.status === "online" &&
      this.connection.supported === true &&
      this.connection.client === client &&
      this.connection.source.clientGeneration === source.clientGeneration &&
      this.connection.source.connectionEpoch === source.connectionEpoch
    );
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

export function createNoteMetadataOwner(input: {
  serverId: string;
  storage: NoteMetadataReplicaStorage | ReplicaCache;
}): NoteMetadataOwner {
  return new NoteMetadataReplicaOwner(input.serverId, input.storage);
}

export const createNoteMetadataReplica = createNoteMetadataOwner;
