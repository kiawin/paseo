export type RemoteImageBehavior = "auto" | "tap-to-load" | "disabled";

const DEFAULT_IMAGE_HANDLERS = [
  "data:image/png;base64",
  "data:image/gif;base64",
  "data:image/jpeg;base64",
] as const;

export function isRemoteImageUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

export function getAllowedImageHandlers(
  allowedImageHandlers: readonly string[] | undefined,
  behavior: RemoteImageBehavior,
): readonly string[] | undefined {
  if (behavior === "auto") return allowedImageHandlers;
  const handlers = [...(allowedImageHandlers ?? DEFAULT_IMAGE_HANDLERS)];
  return handlers.filter((handler) => !/^https?:\/\/$/i.test(handler));
}
