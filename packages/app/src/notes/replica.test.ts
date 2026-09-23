import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { NoteRecordPayload, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";

import {
  createNoteMetadataOwner,
  type NoteMetadataReplicaConnection,
  type NoteMetadataReplicaStorage,
} from "./replica";

const SERVER_ID = "host-a";
const PROJECT_ID = "project-a";

function note(noteId: string, title: string, revision = 1): NoteRecordPayload {
  return {
    noteId,
    projectId: PROJECT_ID,
    displayTitle: title,
    size: title.length,
    contentSha256: `sha-${noteId}-${revision}`,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: `2026-09-21T00:0${revision}:00.000Z`,
    revision,
  };
}

class TestSubscription {
  readonly ready = Promise.resolve({});
  private update: ((message: SessionOutboundMessage) => void) | null = null;
  released = false;

  subscribe(input: { update: (message: SessionOutboundMessage) => void }): void {
    this.update = input.update;
  }

  emit(message: SessionOutboundMessage): void {
    this.update?.(message);
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

class TestStorage implements NoteMetadataReplicaStorage {
  notes: NoteRecordPayload[] = [];
  replacements: Array<{ projectId: string; notes: NoteRecordPayload[] }> = [];
  deletes: Array<{ serverId: string; noteId: string }> = [];
  invalid = false;
  readGate: Promise<void> | null = null;
  readErrors: Error[] = [];
  readCalls = 0;

  async readNoteMetadata(): Promise<{ notes: NoteRecordPayload[]; hasInvalidRows: boolean }> {
    this.readCalls += 1;
    await this.readGate;
    const error = this.readErrors.shift();
    if (error) throw error;
    return { notes: this.notes.map((value) => ({ ...value })), hasInvalidRows: this.invalid };
  }

  replaceNoteMetadata(
    _serverId: string,
    projectId: string,
    notes: readonly NoteRecordPayload[],
  ): void {
    this.replacements.push({ projectId, notes: notes.map((value) => ({ ...value })) });
    this.notes = [
      ...this.notes.filter((value) => value.projectId !== projectId),
      ...notes.map((value) => ({ ...value })),
    ];
  }

  deleteNoteMetadata(serverId: string, noteId: string): void {
    this.deletes.push({ serverId, noteId });
    this.notes = this.notes.filter((value) => value.noteId !== noteId);
  }
}

function connection(
  client: Pick<DaemonClient, "listNotes" | "observeNoteChanges"> | null,
  status: "online" | "offline",
  epoch: number,
  supported: boolean | null = true,
): NoteMetadataReplicaConnection {
  return {
    client,
    status,
    supported,
    source: { clientGeneration: epoch, connectionEpoch: epoch },
  };
}

function createClient(input: {
  notes: NoteRecordPayload[];
  subscription: TestSubscription;
  hold?: Promise<void>;
}): Pick<DaemonClient, "listNotes" | "observeNoteChanges"> {
  return {
    listNotes: async () => {
      await input.hold;
      return input.notes.map((value) => ({ ...value }));
    },
    observeNoteChanges: () =>
      input.subscription as unknown as ReturnType<DaemonClient["observeNoteChanges"]>,
  };
}

describe("note metadata replica owner", () => {
  it("hydrates cached metadata while the host is offline", async () => {
    const storage = new TestStorage();
    storage.notes = [note("note-1", "Cached")];
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.connectionChanged(connection(null, "offline", 1));

    await expect(owner.list(PROJECT_ID)).resolves.toEqual([note("note-1", "Cached")]);
    expect(storage.replacements).toEqual([]);
  });

  it("replaces cached metadata from the network and persists the accepted result", async () => {
    const storage = new TestStorage();
    const subscription = new TestSubscription();
    const client = createClient({ notes: [note("note-1", "Fresh", 2)], subscription });
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.connectionChanged(connection(client, "online", 1));

    await expect(owner.list(PROJECT_ID)).resolves.toEqual([note("note-1", "Fresh", 2)]);
    expect(storage.replacements).toEqual([
      { projectId: PROJECT_ID, notes: [note("note-1", "Fresh", 2)] },
    ]);
  });

  it("deletes an event tombstone and does not restore it after restart", async () => {
    const storage = new TestStorage();
    storage.notes = [note("note-1", "Deleted")];
    const subscription = new TestSubscription();
    const client = createClient({ notes: [], subscription });
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.acquire(PROJECT_ID, "list");
    owner.connectionChanged(connection(null, "offline", 1));
    await owner.list(PROJECT_ID);
    owner.connectionChanged(connection(client, "online", 2));

    subscription.emit({
      type: "note.changed",
      payload: { projectId: PROJECT_ID, noteId: "note-1", revision: null, kind: "delete" },
    });
    expect(storage.deletes).toEqual([{ serverId: SERVER_ID, noteId: "note-1" }]);

    const reopened = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    reopened.connectionChanged(connection(null, "offline", 3));
    await expect(reopened.list(PROJECT_ID)).resolves.toEqual([]);
  });

  it("repairs an invalid row through the network path", async () => {
    const storage = new TestStorage();
    storage.invalid = true;
    storage.notes = [note("note-1", "Do not serve")];
    const subscription = new TestSubscription();
    const client = createClient({ notes: [note("note-1", "Repaired", 2)], subscription });
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.connectionChanged(connection(client, "online", 1));

    await expect(owner.list(PROJECT_ID)).resolves.toEqual([note("note-1", "Repaired", 2)]);
    expect(storage.replacements).toHaveLength(1);
    expect(storage.replacements[0]?.notes[0]?.displayTitle).toBe("Repaired");
  });

  it("does not subscribe or list against a daemon that has not advertised Notes", async () => {
    const storage = new TestStorage();
    const subscription = new TestSubscription();
    const client = createClient({ notes: [note("note-1", "Should stay cached")], subscription });
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.connectionChanged(connection(client, "online", 1, false));
    owner.acquire(PROJECT_ID, "list");

    await expect(owner.list(PROJECT_ID)).resolves.toEqual([]);
    expect(storage.replacements).toEqual([]);
    expect(subscription.released).toBe(false);
  });

  it("delivers note-tab demand without requiring the Notes list to be mounted", async () => {
    const storage = new TestStorage();
    const subscription = new TestSubscription();
    const client = createClient({ notes: [note("note-1", "Fresh", 2)], subscription });
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.connectionChanged(connection(client, "online", 1));
    const release = owner.acquire(PROJECT_ID, "note");

    subscription.emit({
      type: "note.changed",
      payload: { projectId: PROJECT_ID, noteId: "note-1", revision: 2, kind: "update" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(storage.replacements).toEqual([
      { projectId: PROJECT_ID, notes: [note("note-1", "Fresh", 2)] },
    ]);
    release();
    expect(subscription.released).toBe(true);
  });

  it("keeps valid cached rows visible while marking the cache for online repair", async () => {
    const storage = new TestStorage();
    storage.invalid = true;
    storage.notes = [note("note-1", "Valid cached row")];
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.connectionChanged(connection(null, "offline", 1));

    await expect(owner.list(PROJECT_ID)).resolves.toEqual([note("note-1", "Valid cached row")]);
    expect(storage.replacements).toEqual([]);
  });

  it("retries a rejected cache read during the same offline session", async () => {
    const storage = new TestStorage();
    storage.notes = [note("note-1", "Retry me")];
    storage.readErrors.push(new Error("temporary storage failure"));
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.connectionChanged(connection(null, "offline", 1));

    await expect(owner.hydrate(PROJECT_ID)).resolves.toEqual([]);
    await expect(owner.hydrate(PROJECT_ID)).resolves.toEqual([note("note-1", "Retry me")]);
    expect(storage.readCalls).toBe(2);
  });

  it("does not let a late cache read overwrite a newer network result", async () => {
    const storage = new TestStorage();
    let releaseCache!: () => void;
    storage.readGate = new Promise((resolve) => {
      releaseCache = resolve;
    });
    storage.notes = [note("note-1", "Old cache")];
    const subscription = new TestSubscription();
    const client = createClient({ notes: [note("note-1", "New network", 2)], subscription });
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.connectionChanged(connection(null, "offline", 1));
    const lateHydrate = owner.hydrate(PROJECT_ID);

    owner.connectionChanged(connection(client, "online", 2));
    await expect(owner.replace(PROJECT_ID)).resolves.toEqual([note("note-1", "New network", 2)]);
    releaseCache();

    await expect(lateHydrate).resolves.toEqual([note("note-1", "New network", 2)]);
  });

  it("passes metadata only to the cache", async () => {
    const storage = new TestStorage();
    const subscription = new TestSubscription();
    const withBody = { ...note("note-1", "Title"), body: "secret" } as NoteRecordPayload & {
      body: string;
    };
    const client = createClient({ notes: [withBody], subscription });
    const owner = createNoteMetadataOwner({ serverId: SERVER_ID, storage });
    owner.connectionChanged(connection(client, "online", 1));

    await owner.list(PROJECT_ID);

    expect(storage.replacements[0]?.notes[0]).not.toHaveProperty("body");
  });
});
