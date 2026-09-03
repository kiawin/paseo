import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

/** How long the button holds its confirmation before falling back to the copy glyph. */
const COPIED_RESET_MS = 1500;

interface CopyFeedback {
  copied: boolean;
  copy: () => Promise<void>;
}

/**
 * Copy-and-confirm for an icon button. The caller owns the icon and where it sits; this owns the
 * write, the confirmation window, and cancelling it when the button unmounts mid-window — the
 * part every copy button in the app was writing again from scratch.
 *
 * `write` is for content that is not plain text on the clipboard, such as a turn that also goes
 * across as rich markdown.
 */
export function useCopyFeedback(input: {
  getContent: () => string;
  write?: (content: string) => Promise<void>;
}): CopyFeedback {
  const { getContent, write } = input;
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) {
        clearTimeout(resetRef.current);
      }
    },
    [],
  );

  const copy = useCallback(async () => {
    const content = getContent();
    if (!content) {
      return;
    }
    await (write ?? copyToClipboard)(content);
    setCopied(true);
    if (resetRef.current) {
      clearTimeout(resetRef.current);
    }
    resetRef.current = setTimeout(() => {
      setCopied(false);
      resetRef.current = null;
    }, COPIED_RESET_MS);
  }, [getContent, write]);

  return { copied, copy };
}
