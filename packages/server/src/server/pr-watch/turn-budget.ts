/**
 * Daemon-wide cap on agent turns started by PR automation (auto-fix prompts
 * and automatic reviews), so a burst of failing PRs or review requests can't
 * start more agents at once than the machine can run.
 */
export class AutomationTurnBudget {
  private readonly active = new Set<string>();
  private readonly releaseListeners = new Set<() => void>();

  constructor(readonly max: number) {}

  /** Takes a slot for `key`. False when the budget is full. */
  tryAcquire(key: string): boolean {
    if (this.active.has(key)) return true;
    if (this.active.size >= this.max) return false;
    this.active.add(key);
    return true;
  }

  /** Hands a held slot to another key without freeing it in between. */
  transfer(from: string, to: string): void {
    if (!this.active.delete(from)) return;
    this.active.add(to);
  }

  has(key: string): boolean {
    return this.active.has(key);
  }

  release(key: string): void {
    if (!this.active.delete(key)) return;
    for (const listener of this.releaseListeners) listener();
  }

  /** Called after any slot frees up, so waiting work can start. */
  onRelease(listener: () => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  clear(): void {
    this.active.clear();
  }
}
