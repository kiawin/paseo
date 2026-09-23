import type { ArtifactRecordPayload, NoteRecordPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import { downloadArtifactHtml } from "@/artifacts/store";

type SourceClient = Pick<
  DaemonClient,
  "listArtifacts" | "downloadArtifact" | "listNotes" | "readNote"
>;
type TargetClient = Pick<
  DaemonClient,
  | "listArtifacts"
  | "publishArtifact"
  | "listNotes"
  | "saveNote"
  | "setNotePinned"
  | "setNoteArchived"
>;

/** One project placement: `projectId` is host-local, so each side carries its own. */
export interface ProjectOnHost<TClient> {
  client: TClient;
  projectId: string;
}

export interface CopyFailure {
  kind: "artifact" | "note";
  title: string;
  error: string;
}

export interface CopyBetweenHostsResult {
  artifactsCopied: number;
  notesCopied: number;
  /** Already on the target, matched by content (or link, for a link-only artifact). */
  skipped: number;
  failures: CopyFailure[];
}

function artifactIdentity(artifact: ArtifactRecordPayload): string | null {
  if (artifact.contentSha256) return `sha:${artifact.contentSha256}`;
  if (artifact.externalUrl) return `url:${artifact.externalUrl}`;
  return null;
}

type NoteLabel = "pinned" | "archived";

/** The label a copied note should carry on the target. A note is never both pinned and archived. */
function noteLabel(
  note: NoteRecordPayload,
  target: { pinNotes: boolean; archiveNotes: boolean },
): NoteLabel | null {
  if (target.pinNotes && note.pinned === true) return "pinned";
  if (target.archiveNotes && note.archived === true) return "archived";
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copies a project's artifacts and notes from one daemon to another. Nothing is deleted on the
 * source. Rows the target already holds are skipped, so running it again after a partial copy
 * picks up only what is missing. The target refuses a copy that would evict one of its artifacts,
 * so a full project reports failures instead of losing rows, and the skip set stays true.
 */
export async function copyProjectBetweenHosts(input: {
  source: ProjectOnHost<SourceClient>;
  target: ProjectOnHost<TargetClient>;
  /** False when the source daemon predates Notes. */
  includeNotes: boolean;
  /** False when the target daemon predates note pins; pins are then left behind. */
  pinNotes: boolean;
  /** False when the target daemon predates note archiving; archived notes then land active. */
  archiveNotes: boolean;
}): Promise<CopyBetweenHostsResult> {
  const { source, target, includeNotes, pinNotes, archiveNotes } = input;
  const result: CopyBetweenHostsResult = {
    artifactsCopied: 0,
    notesCopied: 0,
    skipped: 0,
    failures: [],
  };

  const [sourceArtifacts, targetArtifacts, sourceNotes, targetNotes] = await Promise.all([
    source.client.listArtifacts(source.projectId),
    target.client.listArtifacts(target.projectId),
    includeNotes ? source.client.listNotes(source.projectId) : [],
    includeNotes ? target.client.listNotes(target.projectId) : [],
  ]);

  const present = new Set(targetArtifacts.map(artifactIdentity));
  // Oldest first: every copy is stamped "now", so publish order becomes the target's recency
  // order, which is how the list sorts.
  const pending = [...sourceArtifacts].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const artifact of pending) {
    const identity = artifactIdentity(artifact);
    if (identity === null || present.has(identity)) {
      result.skipped += 1;
      continue;
    }
    try {
      const html = artifact.contentSha256
        ? await downloadArtifactHtml(source.client, artifact.artifactId)
        : null;
      await target.client.publishArtifact({
        projectId: target.projectId,
        title: artifact.title,
        ...(artifact.customTitle !== undefined ? { customTitle: artifact.customTitle } : {}),
        html,
        externalUrl: artifact.externalUrl,
        pinned: artifact.pinned,
        ...(artifact.archived ? { archived: true } : {}),
      });
      present.add(identity);
      result.artifactsCopied += 1;
    } catch (error) {
      result.failures.push({
        kind: "artifact",
        title: artifact.customTitle ?? artifact.title,
        error: errorMessage(error),
      });
    }
  }

  // `note.save` carries only the body, so a pin or archive is applied after the copy lands. A
  // note the target already holds still gets its label, which is how a second run repairs one a
  // first run could not apply.
  const labelOnTarget = async (noteId: string, title: string, label: NoteLabel) => {
    try {
      if (label === "pinned") {
        await target.client.setNotePinned({ noteId, projectId: target.projectId, pinned: true });
      } else {
        await target.client.setNoteArchived({
          noteId,
          projectId: target.projectId,
          archived: true,
        });
      }
    } catch (error) {
      result.failures.push({ kind: "note", title, error: errorMessage(error) });
    }
  };
  const presentNotes = new Map(targetNotes.map((note) => [note.contentSha256, note] as const));
  for (const note of sourceNotes) {
    const label = noteLabel(note, { pinNotes, archiveNotes });
    const onTarget = presentNotes.get(note.contentSha256);
    if (onTarget) {
      result.skipped += 1;
      if (label && onTarget[label] !== true) {
        await labelOnTarget(onTarget.noteId, note.displayTitle, label);
      }
      continue;
    }
    let savedNoteId: string;
    try {
      const { body } = await source.client.readNote({
        noteId: note.noteId,
        projectId: source.projectId,
      });
      savedNoteId = (await target.client.saveNote({ projectId: target.projectId, body })).note
        .noteId;
    } catch (error) {
      result.failures.push({ kind: "note", title: note.displayTitle, error: errorMessage(error) });
      continue;
    }
    result.notesCopied += 1;
    presentNotes.set(note.contentSha256, {
      ...note,
      noteId: savedNoteId,
      pinned: label === "pinned",
      archived: label === "archived",
    });
    if (label) await labelOnTarget(savedNoteId, note.displayTitle, label);
  }

  return result;
}
