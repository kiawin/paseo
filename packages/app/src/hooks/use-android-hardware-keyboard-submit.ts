import { useEffect, useRef } from "react";
import {
  addHardwareKeyboardSubmitListener,
  setHardwareKeyboardSubmitEnabled,
} from "@/native/hardware-keyboard-submit";
import {
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitController,
} from "./hardware-keyboard-submit-controller";

interface UseAndroidHardwareKeyboardSubmitInput {
  isEnabled: boolean;
  sendOnShiftEnter: boolean;
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
    if ((event?.shiftKey === true) === input.sendOnShiftEnter) {
      input.onSubmit();
    }
  });

  useEffect(() => {
    if (!input.isEnabled) return;
    controller.enable(input.sendOnShiftEnter);
    return () => controller.disable();
  }, [controller, input.isEnabled, input.sendOnShiftEnter]);
}
