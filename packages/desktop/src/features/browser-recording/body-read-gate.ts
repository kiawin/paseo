interface WaitingJob {
  start: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounds physical CDP body reads even when Chromium never settles a command. */
export class BodyReadGate {
  private active = 0;
  private readonly waiting: WaitingJob[] = [];
  private closed = false;
  constructor(
    private readonly maxActive = 4,
    private readonly maxWaiting = 32,
    private readonly waitMs = 4000,
  ) {
    if (![maxActive, maxWaiting, waitMs].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new Error("Invalid body reader limits");
  }
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Body reader is closed"));
    if (this.active >= this.maxActive && this.waiting.length >= this.maxWaiting)
      return Promise.reject(new Error("Body reader queue is full"));
    return new Promise<T>((resolve, reject) => {
      const job: WaitingJob = {
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(job);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          reject(new Error("Body reader queue timed out"));
        }, this.waitMs),
        start: () => {
          clearTimeout(job.timer);
          this.active++;
          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.pump();
            });
        },
      };
      job.timer.unref();
      this.waiting.push(job);
      this.pump();
    });
  }
  private pump(): void {
    while (!this.closed && this.active < this.maxActive && this.waiting.length)
      this.waiting.shift()!.start();
  }
  close(): void {
    this.closed = true;
    for (const job of this.waiting.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new Error("Body reader is closed"));
    }
  }
}
