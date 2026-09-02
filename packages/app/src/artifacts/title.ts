import type { ArtifactRecordPayload } from "@getpaseo/protocol/messages";

export function getArtifactDisplayTitle(
  artifact: Pick<ArtifactRecordPayload, "title" | "customTitle">,
): string {
  return artifact.customTitle ?? artifact.title;
}
