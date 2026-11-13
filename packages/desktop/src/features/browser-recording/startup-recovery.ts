import type { BrowserRecordingStore } from "./store.js";

/** Run the same recovery at desktop startup and in the separate-process capture harness. */
export async function recoverBrowserRecordingsOnStartup(
  store: Pick<BrowserRecordingStore, "recover">,
  hasSingleInstanceLock: boolean,
): Promise<string | null> {
  if (!hasSingleInstanceLock) return "single-instance-lock-disabled";
  try {
    await store.recover();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
