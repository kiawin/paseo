import { rename } from "node:fs/promises";

// Windows readers or scanners can hold the destination across several retries.
const RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800, 1000, 1000];

export async function renameRecordingFile(
  from: string,
  to: string,
  options: {
    platform?: NodeJS.Platform;
    move?: typeof rename;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const move = options.move ?? rename;
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      if (
        platform !== "win32" ||
        (error as NodeJS.ErrnoException)?.code !== "EPERM" ||
        attempt >= RETRY_DELAYS_MS.length
      )
        throw error;
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }
}
