import { describe, expect, test } from "vitest";

import type { ArtifactRecordPayload, NoteRecordPayload } from "@getpaseo/protocol/messages";
import type { PublishArtifactInput } from "@getpaseo/client/internal/daemon-client";
import { copyProjectBetweenHosts } from "./copy-between-hosts";

function artifact(overrides: Partial<ArtifactRecordPayload>): ArtifactRecordPayload {
  return {
    artifactId: "art_1",
    projectId: "prj_old",
    title: "Doc",
    mimeType: "text/html",
    size: 10,
    contentSha256: "a".repeat(64),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    pinned: false,
    externalUrl: null,
    origin: { agentId: "agt_1", workspaceId: "wks_1", provider: "claude" },
    ...overrides,
  };
}

function note(noteId: string, contentSha256: string): NoteRecordPayload {
  return {
    noteId,
    projectId: "prj_old",
    displayTitle: noteId,
    size: 4,
    contentSha256,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 1,
  };
}

/** An in-memory daemon holding one project's artifacts, documents and notes. */
function makeHost(input: {
  artifacts?: ArtifactRecordPayload[];
  html?: Record<string, string>;
  notes?: NoteRecordPayload[];
  bodies?: Record<string, string>;
  failPublishFor?: string;
  failPin?: boolean;
}) {
  const published: PublishArtifactInput[] = [];
  const saved: Array<{ projectId: string; body: string }> = [];
  const pins: Array<{ noteId: string; projectId: string; pinned: boolean }> = [];
  const client = {
    listArtifacts: async () => input.artifacts ?? [],
    downloadArtifact: async ({
      artifactId,
      sink,
    }: {
      artifactId: string;
      sink: { onChunk(chunk: Uint8Array): void };
    }) => {
      sink.onChunk(new TextEncoder().encode(input.html?.[artifactId] ?? ""));
      return { artifactId, title: null, mimeType: "text/html", size: null };
    },
    publishArtifact: async (publish: PublishArtifactInput) => {
      if (publish.title === input.failPublishFor) throw new Error("artifact_too_large");
      published.push(publish);
      return artifact({ projectId: publish.projectId, title: publish.title });
    },
    listNotes: async () => input.notes ?? [],
    readNote: async ({ noteId }: { noteId: string }) => ({
      note: note(noteId, "x"),
      body: input.bodies?.[noteId] ?? "",
    }),
    saveNote: async (save: { projectId: string; body: string }) => {
      saved.push(save);
      return { note: note(`saved_${saved.length}`, "x"), replacedRevision: null };
    },
    setNotePinned: async (pin: { noteId: string; projectId: string; pinned: boolean }) => {
      if (input.failPin) throw new Error("note_not_found");
      pins.push(pin);
      return { ...note(pin.noteId, "x"), pinned: pin.pinned };
    },
  };
  return { client, published, saved, pins };
}

describe("copyProjectBetweenHosts", () => {
  test("copies documents, links, pins and notes into the target's own project", async () => {
    const source = makeHost({
      artifacts: [
        artifact({
          artifactId: "art_new",
          title: "Newer",
          customTitle: "Renamed",
          pinned: true,
          updatedAt: "2026-09-03T00:00:00.000Z",
          externalUrl: "https://claude.ai/code/artifact/1",
        }),
        artifact({
          artifactId: "art_link",
          title: "Link only",
          contentSha256: null,
          size: null,
          externalUrl: "https://claude.ai/code/artifact/2",
          updatedAt: "2026-09-01T00:00:00.000Z",
        }),
      ],
      html: { art_new: "<p>new</p>" },
      notes: [note("n1", "1".repeat(64))],
      bodies: { n1: "# Plan" },
    });
    const target = makeHost({});

    const result = await copyProjectBetweenHosts({
      source: { client: source.client, projectId: "prj_old" },
      target: { client: target.client, projectId: "prj_new" },
      includeNotes: true,
      pinNotes: true,
    });

    expect(result).toEqual({ artifactsCopied: 2, notesCopied: 1, skipped: 0, failures: [] });
    // Oldest first, so the target's recency order matches the source's.
    expect(target.published).toEqual([
      {
        projectId: "prj_new",
        title: "Link only",
        html: null,
        externalUrl: "https://claude.ai/code/artifact/2",
        pinned: false,
      },
      {
        projectId: "prj_new",
        title: "Newer",
        customTitle: "Renamed",
        html: "<p>new</p>",
        externalUrl: "https://claude.ai/code/artifact/1",
        pinned: true,
      },
    ]);
    expect(target.saved).toEqual([{ projectId: "prj_new", body: "# Plan" }]);
  });

  test("skips what the target already holds and keeps going past a failure", async () => {
    const shared = "b".repeat(64);
    const source = makeHost({
      artifacts: [
        artifact({ artifactId: "art_dup", contentSha256: shared }),
        artifact({ artifactId: "art_big", title: "Too big", contentSha256: "c".repeat(64) }),
        artifact({ artifactId: "art_ok", title: "Fine", contentSha256: "d".repeat(64) }),
      ],
      notes: [note("n_dup", "1".repeat(64))],
    });
    const target = makeHost({
      artifacts: [artifact({ artifactId: "art_there", contentSha256: shared })],
      notes: [note("n_there", "1".repeat(64))],
      failPublishFor: "Too big",
    });

    const result = await copyProjectBetweenHosts({
      source: { client: source.client, projectId: "prj_old" },
      target: { client: target.client, projectId: "prj_new" },
      includeNotes: true,
      pinNotes: true,
    });

    expect(result).toEqual({
      artifactsCopied: 1,
      notesCopied: 0,
      skipped: 2,
      failures: [{ kind: "artifact", title: "Too big", error: "artifact_too_large" }],
    });
    expect(target.published.map((p) => p.title)).toEqual(["Fine"]);
  });

  test("leaves notes alone when the source predates them", async () => {
    const source = makeHost({ notes: [note("n1", "1".repeat(64))], bodies: { n1: "# Plan" } });
    source.client.listNotes = async () => {
      throw new Error("unknown message type");
    };
    const target = makeHost({});

    const result = await copyProjectBetweenHosts({
      source: { client: source.client, projectId: "prj_old" },
      target: { client: target.client, projectId: "prj_new" },
      includeNotes: false,
      pinNotes: true,
    });

    expect(result).toEqual({ artifactsCopied: 0, notesCopied: 0, skipped: 0, failures: [] });
    expect(target.saved).toEqual([]);
  });

  test("pins copied notes, and notes the target already has, when the source pinned them", async () => {
    const pinnedFresh = { ...note("n1", "1".repeat(64)), pinned: true };
    const pinnedPresent = { ...note("n2", "2".repeat(64)), pinned: true };
    const plain = note("n3", "3".repeat(64));
    const source = makeHost({
      notes: [pinnedFresh, pinnedPresent, plain],
      bodies: { n1: "# Pinned", n3: "# Plain" },
    });
    // The target holds n2's content unpinned, as a copy made before pins carried over would.
    const target = makeHost({ notes: [{ ...note("t2", "2".repeat(64)) }] });

    const result = await copyProjectBetweenHosts({
      source: { client: source.client, projectId: "prj_old" },
      target: { client: target.client, projectId: "prj_new" },
      includeNotes: true,
      pinNotes: true,
    });

    expect(result).toEqual({ artifactsCopied: 0, notesCopied: 2, skipped: 1, failures: [] });
    expect(target.pins).toEqual([
      { noteId: "saved_1", projectId: "prj_new", pinned: true },
      { noteId: "t2", projectId: "prj_new", pinned: true },
    ]);
  });

  test("leaves pins behind on a target that predates them, and reports a pin that fails", async () => {
    const source = makeHost({
      notes: [{ ...note("n1", "1".repeat(64)), pinned: true }],
      bodies: { n1: "# Pinned" },
    });
    const oldTarget = makeHost({});
    const unpinned = await copyProjectBetweenHosts({
      source: { client: source.client, projectId: "prj_old" },
      target: { client: oldTarget.client, projectId: "prj_new" },
      includeNotes: true,
      pinNotes: false,
    });
    expect(unpinned).toMatchObject({ notesCopied: 1, failures: [] });
    expect(oldTarget.pins).toEqual([]);

    const failingTarget = makeHost({ failPin: true });
    const failed = await copyProjectBetweenHosts({
      source: { client: source.client, projectId: "prj_old" },
      target: { client: failingTarget.client, projectId: "prj_new" },
      includeNotes: true,
      pinNotes: true,
    });
    // The body landed, so it counts as copied; the pin is reported and a re-run applies it.
    expect(failed).toEqual({
      artifactsCopied: 0,
      notesCopied: 1,
      skipped: 0,
      failures: [{ kind: "note", title: "n1", error: "note_not_found" }],
    });
  });
});
