import { isWeb } from "@/constants/platform";

/**
 * True while text is highlighted on the page. A drag that selects text ends in a click on
 * whatever `Pressable` wraps that text, so a row or card whose press changes what is on screen
 * checks this first — otherwise selecting code closes the thing you were reading.
 *
 * Native has no equivalent: `Text selectable` owns the gesture there and never hands the parent
 * a press.
 */
export function hasActiveTextSelection(): boolean {
  if (!isWeb) {
    return false;
  }
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
}
