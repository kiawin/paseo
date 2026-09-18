import { createNativeTextMeasurer } from "@/git/diff-document/text.native";
import type { TextMeasurer } from "@/text-measurement";

export function createCsvTextMeasurer(input: {
  configuredFamily: string;
  fontSize: number;
}): TextMeasurer {
  return createNativeTextMeasurer(input);
}
