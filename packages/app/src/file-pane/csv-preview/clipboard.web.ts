import { isWeb } from "@/constants/platform";

export async function copyCsvText(text: string): Promise<void> {
  if (!isWeb || !navigator.clipboard) {
    throw new Error("Clipboard copy is unavailable in this browser");
  }
  await navigator.clipboard.writeText(text);
}
