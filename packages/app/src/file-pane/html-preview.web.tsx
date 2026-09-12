import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type PreviewDocumentUrl, withPreviewCsp } from "./html-preview-csp";

// `allow-scripts` alone: the file gets an opaque origin, so a plan page can run
// its own scripts (Excalidraw, charts) but cannot reach the Paseo app's DOM,
// cookies, or storage, and cannot navigate the top window. Agent-written HTML is
// not trusted markup. No popup tokens — a preview is a viewer, not a browser, and
// escaping the sandbox to open one buys nothing for reading a local plan. The same
// isolation means storage APIs throw inside the frame; pages that want to persist
// state have to export.
//
// A sandboxed frame may still navigate *itself*, and nothing in CSP stops that
// (see html-preview-csp.ts). That is the one hole left on web, it is bounded to
// the page's own contents, and it is documented in SECURITY.md rather than papered
// over with a directive browsers ignore.
const SANDBOX = "allow-scripts";

// The URL a `srcDoc` document loads under. It has to be handed to the policy so the
// document gets a base of its own: a srcdoc document inherits the parent page's base
// URL, and a preview whose links resolve against the app's URL navigates itself off
// the pane the moment anyone clicks one. See html-preview-csp.ts.
const DOCUMENT_URL: PreviewDocumentUrl = "about:srcdoc";

const iframeStyle = {
  flex: 1,
  minHeight: 0,
  border: "none",
  backgroundColor: "white",
} as const;

export function FileHtmlPreview({ html, testID }: { html: string; testID?: string }) {
  const { t } = useTranslation();
  const document = useMemo(() => withPreviewCsp(html, DOCUMENT_URL), [html]);
  return (
    <iframe
      data-testid={testID}
      title={t("panels.file.editor.preview")}
      srcDoc={document}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      style={iframeStyle}
    />
  );
}
