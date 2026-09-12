// A preview renders a self-contained document and nothing else. Inline styles and
// scripts run so a plan page keeps its layout and its diagrams; fetch, XHR,
// WebSocket, beacon, remote script, remote font, remote image, and form posts are
// all refused. Agent-written HTML is not trusted markup.
//
// What this does NOT stop: the document navigating itself. No CSP directive
// available in current browsers prevents it — `navigate-to` was dropped from CSP3
// and is unenforced, and `<meta http-equiv="refresh">` needs no script at all
// (both verified against the Chromium this app ships against). So a hostile page
// can still reach a server by navigating, carrying data available inside the
// preview. The opaque origin is what bounds the damage: the frame has no storage,
// no parent access, and no way to read any file but itself. Native narrows it
// further in html-preview.tsx, because a WebView can refuse navigation outside CSP — see the
// caveat there on why that is a mitigation rather than a guarantee.
const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

const META = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

// The URL the preview document loads under, which is the only thing its base may
// be set to. Native pins `about:blank` through the WebView's base URL; web gets
// `about:srcdoc` from the iframe. A union rather than a string keeps the value
// under this module's control — it is interpolated into markup unescaped.
export type PreviewDocumentUrl = "about:blank" | "about:srcdoc";

// The policy must reach the parser before any markup the document declares, and it
// only counts if it lands in `<head>` — once the parser has moved on to `<body>`, a
// meta http-equiv CSP is ignored outright.
//
// Locating the document's own doctype to insert after it means reimplementing the
// tokenizer's initial insertion mode: its exact whitespace set (JS `\s` matches
// characters HTML does not, and one stray NBSP is enough to push the policy into
// the body where it stops applying), every comment ending including `--!>`, `<!-->`
// and `<!--->`, bogus-comment tokens like `<?xml …?>` and `<![CDATA[…]]>`, and the
// rule that a doctype closes at the first `>` in every state. Each of those rules
// cost a bug before it was right.
//
// So the prologue isn't found, it's supplied: our doctype, our base, then the
// policy, then the file verbatim. The file's own doctype becomes a stray DOCTYPE
// token, which the parser ignores wherever it appears. Standards mode is
// guaranteed, the policy is always the first element and therefore always in the
// head, and no part of the document has to be parsed to place it.
//
// The base element states the document's own URL, and it goes before the policy
// rather than after. A srcdoc document inherits the *parent page's* base URL, so
// without this a bare `#section` link resolves against the Paseo app's URL and
// navigates the frame off the preview instead of scrolling it. Before the policy is
// the only position that works: `base-uri 'none'` blocks every base element parsed
// once the policy is live. That ordering also settles which base wins — ours is the
// first with an href, and the document's own is blocked outright.
function prologue(documentUrl: PreviewDocumentUrl): string {
  return `<!doctype html><base href="${documentUrl}">${META}`;
}

// Left where it is, a BOM would sit mid-document and render as a zero-width space.
const BOM = "\uFEFF";

export function withPreviewCsp(html: string, documentUrl: PreviewDocumentUrl): string {
  return prologue(documentUrl) + (html.startsWith(BOM) ? html.slice(BOM.length) : html);
}
