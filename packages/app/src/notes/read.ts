export function noteReadInput(
  noteId: string,
  projectId: string | null,
): {
  noteId: string;
  projectId?: string;
} {
  return projectId ? { noteId, projectId } : { noteId };
}
