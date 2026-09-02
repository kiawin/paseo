/**
 * The host of an external URL, for labelling a link by where it goes.
 *
 * Agent-supplied URLs reach surfaces that invite clicking — an artifact's companion link, a
 * published-document tool call. Naming the destination before the tap is the mitigation, so the
 * label is derived here rather than at each call site. Null means the string is not a URL and
 * the caller should show it verbatim instead of inventing a label for it.
 */
export function externalLinkHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
