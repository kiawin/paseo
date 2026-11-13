/** Bounds retained network state across every view in one recording. */
export class CaptureBudget {
  private used = 0;
  constructor(
    readonly limit: number,
    private readonly parent?: CaptureBudget,
  ) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid capture budget");
  }
  reserve(bytes: number): (() => void) | null {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || this.used + bytes > this.limit) return null;
    const releaseParent = this.parent?.reserve(bytes);
    if (this.parent && !releaseParent) return null;
    this.used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= bytes;
      releaseParent?.();
    };
  }
  get usedBytes(): number {
    return this.used;
  }
}
