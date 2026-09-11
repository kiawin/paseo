import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type {
  HardwareKeyboardSubmitChord,
  HardwareKeyboardSubmitEvent,
} from "@/hooks/hardware-keyboard-submit-controller";

interface PaseoHardwareKeyboardModule {
  setHardwareKeyboardSubmitEnabled(
    enabled: boolean,
    requireShift: boolean,
    requireMod: boolean,
  ): void;
  addListener(
    eventName: "onHardwareKeyboardSubmit",
    handler: (event: HardwareKeyboardSubmitEvent) => void,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export function setHardwareKeyboardSubmitEnabled(
  enabled: boolean,
  sendChord: HardwareKeyboardSubmitChord = { shiftKey: false, modKey: false },
): void {
  module.setHardwareKeyboardSubmitEnabled(enabled, sendChord.shiftKey, sendChord.modKey);
}

export function addHardwareKeyboardSubmitListener(
  handler: (event?: HardwareKeyboardSubmitEvent) => void,
): EventSubscription {
  return module.addListener("onHardwareKeyboardSubmit", handler);
}
