import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type { HardwareKeyboardSubmitEvent } from "@/hooks/hardware-keyboard-submit-controller";

interface PaseoHardwareKeyboardModule {
  setHardwareKeyboardSubmitEnabled(enabled: boolean, sendOnShiftEnter: boolean): void;
  addListener(
    eventName: "onHardwareKeyboardSubmit",
    handler: (event: HardwareKeyboardSubmitEvent) => void,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export function setHardwareKeyboardSubmitEnabled(enabled: boolean, sendOnShiftEnter = false): void {
  module.setHardwareKeyboardSubmitEnabled(enabled, sendOnShiftEnter);
}

export function addHardwareKeyboardSubmitListener(
  handler: (event?: HardwareKeyboardSubmitEvent) => void,
): EventSubscription {
  return module.addListener("onHardwareKeyboardSubmit", handler);
}
