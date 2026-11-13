export type RecordingStorageError = "quota" | "disk-full" | "other";
export function classifyStorageError(error: unknown): RecordingStorageError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  if (
    code === "ENOSPC" ||
    code === "EDQUOT" ||
    /\b(?:ENOSPC|EDQUOT)\b|no space left on device/i.test(message)
  )
    return "disk-full";
  if (/recording (?:storage )?quota (?:exceeded|reached)/i.test(message)) return "quota";
  return "other";
}
