import type { EventSubscription } from "expo-modules-core";
import type {
  HardwareKeyboardSubmitChord,
  HardwareKeyboardSubmitEvent,
} from "@/hooks/hardware-keyboard-submit-controller";

export function setHardwareKeyboardSubmitEnabled(
  _enabled: boolean,
  _sendChord?: HardwareKeyboardSubmitChord,
): void {}

export function addHardwareKeyboardSubmitListener(
  _handler: (event?: HardwareKeyboardSubmitEvent) => void,
): EventSubscription {
  return { remove: () => {} };
}
