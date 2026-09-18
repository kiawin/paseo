import type { TextMeasurer } from "@/text-measurement";

export function createCsvTextMeasurer(_input: {
  configuredFamily: string;
  fontSize: number;
}): TextMeasurer {
  throw new Error("CSV text measurement is not available on this platform");
}
