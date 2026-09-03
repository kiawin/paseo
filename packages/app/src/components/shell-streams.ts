/**
 * A shell call's two streams, as the card needs them.
 *
 * `shown` is clamped to the preview's line budget; `full` is not. Copy writes `full`: the preview
 * is a teaser for the card behind it, and a teaser is not what someone meant to put on their
 * clipboard.
 */
export interface ShellStream {
  shown: string;
  full: string;
}

export interface ShellStreams {
  command: ShellStream;
  /** Null when the command printed nothing, so the card draws no OUT row at all. */
  output: ShellStream | null;
}

/** Keeps at most `limit` whole lines, and says whether anything was dropped. */
export function takeLines(
  text: string,
  limit: number | undefined,
): { text: string; truncated: boolean } {
  if (limit === undefined) {
    return { text, truncated: false };
  }
  const lines = text.split("\n");
  if (lines.length <= limit) {
    return { text, truncated: false };
  }
  return { text: lines.slice(0, limit).join("\n"), truncated: true };
}

/**
 * IN and OUT are clamped independently, so a long command cannot crowd out the output it
 * produced.
 */
export function buildShellStreams(
  command: string,
  output: string | null | undefined,
  previewLines: number | undefined,
): ShellStreams {
  const fullCommand = command.replace(/\n+$/, "");
  const fullOutput = (output ?? "").replace(/^\n+/, "");
  return {
    command: { shown: takeLines(fullCommand, previewLines).text, full: fullCommand },
    output:
      fullOutput.length > 0
        ? { shown: takeLines(fullOutput, previewLines).text, full: fullOutput }
        : null,
  };
}
