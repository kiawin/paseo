import { isWeb } from "@/constants/platform";
import {
  createChunkedWidthMeasurer,
  createMeasuredAdvances,
  type TextMeasurer,
} from "@/text-measurement";

export function createCsvTextMeasurer(input: {
  configuredFamily: string;
  fontSize: number;
}): TextMeasurer {
  if (!isWeb) throw new Error("Canvas text measurement requires a web runtime");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return { measure: () => 0 };
  const measure = (text: string) => {
    context.font = `${input.fontSize}px ${input.configuredFamily}`;
    return context.measureText(text).width;
  };
  return {
    measure,
    measureAdvances: createMeasuredAdvances(measure),
    measureWidth: createChunkedWidthMeasurer((graphemes) => measure(graphemes.join(""))),
  };
}
