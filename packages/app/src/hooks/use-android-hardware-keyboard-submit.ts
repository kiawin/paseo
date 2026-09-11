import { useEffect, useRef } from "react";
import {
  addHardwareKeyboardSubmitListener,
  setHardwareKeyboardSubmitEnabled,
} from "@/native/hardware-keyboard-submit";
import {
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitChord,
  type HardwareKeyboardSubmitController,
} from "./hardware-keyboard-submit-controller";

interface UseAndroidHardwareKeyboardSubmitInput {
  isEnabled: boolean;
  sendChord: HardwareKeyboardSubmitChord;
  onSubmit: () => void;
}

export function useAndroidHardwareKeyboardSubmit(input: UseAndroidHardwareKeyboardSubmitInput) {
  const controllerRef = useRef<HardwareKeyboardSubmitController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createHardwareKeyboardSubmitController({
      addListener: addHardwareKeyboardSubmitListener,
      setEnabled: setHardwareKeyboardSubmitEnabled,
    });
  }
  const controller = controllerRef.current;

  controller.setOnSubmit((event) => {
    if (
      (event?.shiftKey === true) === input.sendChord.shiftKey &&
      (event?.modKey === true) === input.sendChord.modKey
    ) {
      input.onSubmit();
    }
  });

  useEffect(() => {
    if (!input.isEnabled) return;
    controller.enable(input.sendChord);
    return () => controller.disable();
  }, [controller, input.isEnabled, input.sendChord]);
}
