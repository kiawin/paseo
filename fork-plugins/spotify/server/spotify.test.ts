import { describe, expect, it } from "vitest";
import { FIELD_SEPARATOR } from "../shared/spotify";
import { parseSnapshot } from "./spotify";

function payload(...fields: string[]): string {
  return fields.join(FIELD_SEPARATOR);
}

describe("parseSnapshot", () => {
  it("reads a playing track", () => {
    const snapshot = parseSnapshot(
      payload(
        "playing",
        "Midnight City",
        "M83",
        "Hurry Up, We're Dreaming",
        "https://i.scdn.co/image/abc",
        "72000",
        "243000",
      ),
    );
    expect(snapshot).toEqual({
      available: true,
      state: "playing",
      track: "Midnight City",
      artist: "M83",
      album: "Hurry Up, We're Dreaming",
      artworkUrl: "https://i.scdn.co/image/abc",
      positionMs: 72000,
      durationMs: 243000,
    });
  });

  it("keeps separators, quotes, and commas that appear inside metadata", () => {
    const snapshot = parseSnapshot(
      payload("paused", 'Marquee Moon | "Live", 1977', "Television", "Adventure", "", "0", "1000"),
    );
    expect(snapshot.track).toBe('Marquee Moon | "Live", 1977');
    expect(snapshot.state).toBe("paused");
  });

  it("treats empty metadata as absent rather than empty strings", () => {
    const snapshot = parseSnapshot(payload("playing", "Untitled", "", "", "", "0", "0"));
    expect(snapshot.artist).toBeUndefined();
    expect(snapshot.artworkUrl).toBeUndefined();
  });

  it("maps the status sentinels", () => {
    expect(parseSnapshot("STATUS:not_running")).toEqual({
      available: false,
      reason: "not_running",
    });
    expect(parseSnapshot("STATUS:no_spotify")).toEqual({ available: false, reason: "no_spotify" });
    expect(parseSnapshot("STATUS:stopped")).toEqual({ available: true, state: "stopped" });
  });

  it("reports malformed output instead of guessing", () => {
    expect(parseSnapshot("playing|~|only|~|three").reason).toBe("error");
    expect(parseSnapshot("STATUS:something-new").reason).toBe("error");
  });

  it("ignores a trailing newline from osascript", () => {
    const snapshot = parseSnapshot(`${payload("playing", "A", "B", "C", "", "1", "2")}\n`);
    expect(snapshot.durationMs).toBe(2);
  });
});
