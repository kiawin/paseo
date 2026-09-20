import { execFile } from "node:child_process";

/** A wedged Spotify can leave an Apple event outstanding; never block a poll longer than this. */
const OSASCRIPT_TIMEOUT_MS = 5_000;

/**
 * macOS denies Apple events with -1743 when the responsible process has no
 * Automation consent. Packaged Paseo.app also lands here when its Info.plist
 * carries no NSAppleEventsUsageDescription, because the consent dialog is
 * suppressed and the grant can never be given.
 */
const DENIED_PATTERN = /-1743|Not authorized to send Apple events/i;

export type AppleScriptOutcome =
  | { ok: true; stdout: string }
  | { ok: false; denied: boolean; message: string };

/**
 * Runs a fixed script through osascript. The script is always a module constant;
 * nothing from the client is interpolated into AppleScript source, and argv form
 * keeps a shell out of the path entirely.
 */
export function runAppleScript(script: string): Promise<AppleScriptOutcome> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: OSASCRIPT_TIMEOUT_MS, maxBuffer: 1024 * 64 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout: stdout.toString() });
          return;
        }
        const message = (stderr.toString() || error.message).trim();
        resolve({ ok: false, denied: DENIED_PATTERN.test(message), message });
      },
    );
  });
}
