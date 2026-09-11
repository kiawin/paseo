/** The Enter chord the native side should claim. `modKey` is Command on macOS, Control elsewhere. */
export interface HardwareKeyboardSubmitChord {
  shiftKey: boolean;
  modKey: boolean;
}

export interface HardwareKeyboardSubmitEvent {
  shiftKey?: boolean;
  modKey?: boolean;
}

export interface HardwareKeyboardSubmitListenerPort {
  addListener(handler: (event?: HardwareKeyboardSubmitEvent) => void): { remove: () => void };
  setEnabled(enabled: boolean, sendChord?: HardwareKeyboardSubmitChord): void;
}

export interface HardwareKeyboardSubmitController {
  setOnSubmit(handler: (event?: HardwareKeyboardSubmitEvent) => void): void;
  enable(sendChord?: HardwareKeyboardSubmitChord): void;
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
    enable(sendChord) {
      if (subscription) return;
      subscription = port.addListener((event) => onSubmit(event));
      port.setEnabled(true, sendChord);
    },
    disable() {
      if (!subscription) return;
      port.setEnabled(false);
      subscription.remove();
      subscription = null;
    },
  };
}
