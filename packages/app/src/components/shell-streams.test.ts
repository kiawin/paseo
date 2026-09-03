import { describe, expect, it } from "vitest";
import { buildShellStreams } from "./shell-streams";

describe("buildShellStreams", () => {
  it("trims the seam between the two streams", () => {
    const streams = buildShellStreams("ls -la\n\n", "\n\ntotal 0", undefined);
    expect(streams.command.full).toBe("ls -la");
    expect(streams.output?.full).toBe("total 0");
  });

  it("draws no output row when the command printed nothing", () => {
    expect(buildShellStreams("true", "", undefined).output).toBeNull();
    expect(buildShellStreams("true", null, undefined).output).toBeNull();
    expect(buildShellStreams("true", "\n\n", undefined).output).toBeNull();
  });

  // Copy writes `full`, so a clamped card must not hand a truncated command to the clipboard.
  it("clamps what the card shows without clamping what copy writes", () => {
    const command = "one\ntwo\nthree\nfour";
    const output = "a\nb\nc\nd\ne";
    const streams = buildShellStreams(command, output, 2);
    expect(streams.command.shown).toBe("one\ntwo");
    expect(streams.command.full).toBe(command);
    expect(streams.output?.shown).toBe("a\nb");
    expect(streams.output?.full).toBe(output);
  });

  // Each stream gets the whole budget, so a long command cannot crowd out the output it produced.
  it("clamps the streams independently", () => {
    const streams = buildShellStreams("one\ntwo\nthree", "only", 2);
    expect(streams.command.shown).toBe("one\ntwo");
    expect(streams.output?.shown).toBe("only");
  });
});
