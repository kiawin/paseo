import { expect, it, vi } from "vitest";
import { BodyReadGate } from "./body-read-gate.js";

it("does not dispatch more CDP reads when every physical slot hangs", async () => {
  vi.useFakeTimers();
  const gate = new BodyReadGate(16, 64, 4000);
  const releases: Array<() => void> = [];
  try {
    const pending = Array.from({ length: 16 }, () =>
      gate.run(() => new Promise<void>((resolve) => releases.push(resolve))),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(16);
    const next = vi.fn(async () => "not sent");
    const waiting = gate.run(next);
    const rejected = expect(waiting).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(4001);
    await rejected;
    expect(next).not.toHaveBeenCalled();
    releases.forEach((release) => release());
    await Promise.all(pending);
  } finally {
    gate.close();
    vi.useRealTimers();
  }
});
