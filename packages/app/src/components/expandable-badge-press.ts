/**
 * Which presses on a tool call's detail surface toggle the card.
 *
 * The clamped preview carries the expand pill, so the preview has to be what opens the full card —
 * the header row is the wrong thing to aim at when the pill is what you are reading. Expanded, the
 * same surface puts the card away, so one target both opens and closes it.
 *
 * That second half works only because the press handler drops a press that ends a text selection
 * (see `hasActiveTextSelection`), which is what keeps a drag across expanded code from closing the
 * card mid-copy.
 */
export function canPressDetailSurface(input: {
  hasDetailContent: boolean;
  isExpanded: boolean;
  showCollapsedPreview: boolean | undefined;
  isInteractive: boolean;
}): boolean {
  if (!input.hasDetailContent || !input.isInteractive) {
    return false;
  }
  return input.isExpanded || Boolean(input.showCollapsedPreview);
}
