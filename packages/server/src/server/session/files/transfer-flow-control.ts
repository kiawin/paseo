/**
 * Unacked-byte ceiling for one daemon -> client binary transfer.
 *
 * On a direct socket the sender feels TCP backpressure, so a naive send loop is safe.
 * A relay does not give us that: the Cloudflare Durable Object forwards with `ws.send()`
 * and exposes no drain signal, so streaming a large file to a slow phone would grow relay
 * memory without bound. The sender therefore stops once `windowBytes` is outstanding and
 * resumes on the next `fs.transfer.ack`.
 *
 * The window is well under the relay's 32 MiB frame ceiling, so a stalled transfer parks
 * rather than trips it.
 */
export const TRANSFER_WINDOW_BYTES = 8 * 1024 * 1024;

export class TransferFlowControl {
  private sentBytes = 0;
  private ackedBytes = 0;
  private cancelled = false;
  private wake: (() => void) | null = null;

  constructor(private readonly windowBytes: number = TRANSFER_WINDOW_BYTES) {}

  get isCancelled(): boolean {
    return this.cancelled;
  }

  recordSent(bytes: number): void {
    this.sentBytes += bytes;
  }

  /**
   * Acks carry a cumulative byte count, so a reordered or duplicated ack cannot
   * walk the window backwards.
   */
  onAck(bytesReceived: number): void {
    if (bytesReceived > this.ackedBytes) {
      this.ackedBytes = bytesReceived;
    }
    this.release();
  }

  cancel(): void {
    this.cancelled = true;
    this.release();
  }

  /** Resolves once the transfer is back under its window, or has been cancelled. */
  async awaitWindow(): Promise<void> {
    while (!this.cancelled && this.sentBytes - this.ackedBytes >= this.windowBytes) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private release(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
