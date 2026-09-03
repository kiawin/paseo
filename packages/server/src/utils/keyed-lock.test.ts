import { describe, expect, it } from "vitest";
import { KeyedLock, pathLockKey } from "./keyed-lock.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("KeyedLock", () => {
  it("serializes operations sharing a key", async () => {
    const lock = new KeyedLock();
    const gate = deferred<void>();
    const order: string[] = [];

    const first = lock.run("a", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = lock.run("a", async () => {
      order.push("second:start");
    });

    // The second operation must not have begun while the first holds the key.
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not block across different keys", async () => {
    const lock = new KeyedLock();
    const gate = deferred<void>();
    const order: string[] = [];

    const held = lock.run("a", async () => {
      await gate.promise;
      order.push("a");
    });
    await lock.run("b", async () => {
      order.push("b");
    });

    expect(order).toEqual(["b"]);
    gate.resolve();
    await held;
    expect(order).toEqual(["b", "a"]);
  });

  // A failure must not poison the key: the archive path queues real work behind
  // operations that can legitimately throw.
  it("runs queued work after the holder rejects", async () => {
    const lock = new KeyedLock();

    await expect(
      lock.run("a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(lock.run("a", async () => "after")).resolves.toBe("after");
  });

  it("treats path spellings that name the same directory as one key", () => {
    expect(pathLockKey("/tmp/holder/feat")).toBe(pathLockKey("/tmp/holder/feat/"));
    expect(pathLockKey("/tmp/holder/feat")).not.toBe(pathLockKey("/tmp/holder/other"));
  });
});
