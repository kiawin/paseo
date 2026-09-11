import type { EventSubscription } from "expo-modules-core";
import type { HardwareKeyboardSubmitEvent } from "@/hooks/hardware-keyboard-submit-controller";

export function setHardwareKeyboardSubmitEnabled(
  _enabled: boolean,
  _sendOnShiftEnter?: boolean,
): void {}

export function addHardwareKeyboardSubmitListener(
  _handler: (event?: HardwareKeyboardSubmitEvent) => void,
): EventSubscription {
  return { remove: () => {} };
}
