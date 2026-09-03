import { normalizePathForIdentity } from "./path.js";

/**
 * Serializes work that shares a key, so two operations on the same resource
 * cannot interleave. Different keys never block each other.
 *
 * In-process only: it orders work inside one daemon and says nothing about
 * other processes touching the same paths.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    // Chain off the previous holder settling either way: a rejection there must
    // not cancel the work queued behind it.
    const result = previous.then(
      () => operation(),
      () => operation(),
    );

    // The tail tracks completion only, and swallows so an unhandled rejection is
    // never reported against the queue. `result` still rejects for its own caller.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);

    try {
      return await result;
    } finally {
      // Only the last operation for this key clears it; if something newer has
      // queued behind us it owns the tail now. Keeps the map from growing
      // without bound across a long-lived daemon.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

/** Normalizes a filesystem path into a lock key, so path spellings share a lock. */
export function pathLockKey(path: string): string {
  return normalizePathForIdentity(path);
}
