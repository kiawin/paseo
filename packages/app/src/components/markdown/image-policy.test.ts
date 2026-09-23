import { describe, expect, it } from "vitest";

import { getAllowedImageHandlers, isRemoteImageUrl } from "./image-policy";

describe("remote image policy", () => {
  const handlers = ["data:image/png;base64", "https://", "http://"];

  it("identifies only HTTP(S) images as remote", () => {
    expect(isRemoteImageUrl("https://example.com/image.png")).toBe(true);
    expect(isRemoteImageUrl("http://example.com/image.png")).toBe(true);
    expect(isRemoteImageUrl("data:image/png;base64,abc")).toBe(false);
    expect(isRemoteImageUrl("/local/image.png")).toBe(false);
  });

  it("keeps the existing handlers in auto mode", () => {
    expect(getAllowedImageHandlers(handlers, "auto")).toBe(handlers);
  });

  it("removes only remote handlers for tap-to-load and disabled", () => {
    expect(getAllowedImageHandlers(handlers, "tap-to-load")).toEqual(["data:image/png;base64"]);
    expect(getAllowedImageHandlers(handlers, "disabled")).toEqual(["data:image/png;base64"]);
  });
});
