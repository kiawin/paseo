interface FrameProducer {
  isDestroyed(): boolean;
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
}
const holds = new WeakMap<FrameProducer, { count: number; previous: boolean }>();

export function hasConcurrentFrameConsumers(contents: FrameProducer): boolean {
  return (holds.get(contents)?.count ?? 0) > 1;
}

// Screenshot and video capture share this hold; the last user restores the policy.
export function holdFrameProduction(contents: FrameProducer): () => void {
  let hold = holds.get(contents);
  if (!hold) {
    hold = { count: 0, previous: contents.getBackgroundThrottling() };
    contents.setBackgroundThrottling(false);
    holds.set(contents, hold);
  }
  hold.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--hold.count === 0) {
      holds.delete(contents);
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(hold.previous);
    }
  };
}
