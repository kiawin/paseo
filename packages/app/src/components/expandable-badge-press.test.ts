import { describe, expect, it } from "vitest";
import { canPressDetailSurface } from "./expandable-badge-press";

const base = {
  hasDetailContent: true,
  isExpanded: false,
  showCollapsedPreview: true,
  isInteractive: true,
};

describe("canPressDetailSurface", () => {
  it("opens the card from a clamped preview", () => {
    expect(canPressDetailSurface(base)).toBe(true);
  });

  it("closes the card from its expanded content", () => {
    expect(canPressDetailSurface({ ...base, isExpanded: true })).toBe(true);
  });

  // A card with no teaser has nothing to aim at until it is open, and then its content is the
  // only thing on screen to press.
  it("stays inert while a card without a teaser is closed", () => {
    expect(canPressDetailSurface({ ...base, showCollapsedPreview: undefined })).toBe(false);
    expect(
      canPressDetailSurface({ ...base, showCollapsedPreview: undefined, isExpanded: true }),
    ).toBe(true);
  });

  it("needs something to press and something to toggle", () => {
    expect(canPressDetailSurface({ ...base, hasDetailContent: false })).toBe(false);
    expect(canPressDetailSurface({ ...base, isExpanded: true, hasDetailContent: false })).toBe(
      false,
    );
    expect(canPressDetailSurface({ ...base, isInteractive: false })).toBe(false);
    expect(canPressDetailSurface({ ...base, isExpanded: true, isInteractive: false })).toBe(false);
  });
});
