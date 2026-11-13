import { expect, it, vi } from "vitest";
import { holdFrameProduction } from "./frame-production.js";

it("keeps frames enabled until both video and screenshot release their holds", () => {
  let throttled = true;
  const target = {
    isDestroyed: () => false,
    getBackgroundThrottling: () => throttled,
    setBackgroundThrottling: vi.fn((value: boolean) => {
      throttled = value;
    }),
  };
  const releaseVideo = holdFrameProduction(target);
  const releaseScreenshot = holdFrameProduction(target);
  releaseVideo();
  expect(throttled).toBe(false);
  releaseScreenshot();
  releaseScreenshot();
  expect(throttled).toBe(true);
  expect(target.setBackgroundThrottling).toHaveBeenCalledTimes(2);
});
