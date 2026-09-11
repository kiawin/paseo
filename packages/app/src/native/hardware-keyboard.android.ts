import { requireOptionalNativeModule } from "expo-modules-core";

interface PaseoHardwareKeyboardModule {
  hasHardwareKeyboard(): boolean;
}

const module = requireOptionalNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export function hasHardwareKeyboard(): boolean {
  return module?.hasHardwareKeyboard() ?? false;
}
