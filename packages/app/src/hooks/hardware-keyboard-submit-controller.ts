export interface HardwareKeyboardSubmitEvent {
  shiftKey?: boolean;
}

export interface HardwareKeyboardSubmitListenerPort {
  addListener(handler: (event?: HardwareKeyboardSubmitEvent) => void): { remove: () => void };
  setEnabled(enabled: boolean, sendOnShiftEnter?: boolean): void;
}

export interface HardwareKeyboardSubmitController {
  setOnSubmit(handler: (event?: HardwareKeyboardSubmitEvent) => void): void;
  enable(sendOnShiftEnter?: boolean): void;
  disable(): void;
}

export function createHardwareKeyboardSubmitController(
  port: HardwareKeyboardSubmitListenerPort,
): HardwareKeyboardSubmitController {
  let subscription: { remove: () => void } | null = null;
  let onSubmit: (event?: HardwareKeyboardSubmitEvent) => void = () => {};

  return {
    setOnSubmit(handler) {
      onSubmit = handler;
    },
    enable(sendOnShiftEnter) {
      if (subscription) return;
      subscription = port.addListener((event) => onSubmit(event));
      port.setEnabled(true, sendOnShiftEnter);
    },
    disable() {
      if (!subscription) return;
      port.setEnabled(false);
      subscription.remove();
      subscription = null;
    },
  };
}
