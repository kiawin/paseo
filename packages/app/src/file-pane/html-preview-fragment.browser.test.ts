import invariant from "tiny-invariant";
import { describe, expect, it } from "vitest";
import { withPreviewCsp } from "@/file-pane/html-preview-csp";

// A document tall enough that scrolling to the anchor moves the frame, so a real
// same-document jump is distinguishable from a navigation that lands at offset 0.
const DOCUMENT = `<a id="link" href="#section">Jump</a><h2 id="section" style="margin-top:2000px">Section</h2>`;

// `allow-same-origin` is added so the test can read the frame. It has no bearing on
// what is under test: base URL resolution and same-document navigation work the
// same way in the production sandbox, which is `allow-scripts` alone.
const OBSERVABLE_SANDBOX = ["allow-scripts", "allow-same-origin"];

async function clickTheLink(previewDocument: string) {
  const frame = document.createElement("iframe");
  frame.sandbox.add(...OBSERVABLE_SANDBOX);
  frame.srcdoc = previewDocument;
  await new Promise((resolve) => {
    frame.addEventListener("load", resolve, { once: true });
    document.body.appendChild(frame);
  });

  let reloaded = false;
  frame.addEventListener("load", () => {
    reloaded = true;
  });
  const link = frame.contentDocument?.getElementById("link");
  invariant(link, "the preview document declares the link this test clicks");
  (link as HTMLAnchorElement).click();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const result = {
    reloaded,
    url: frame.contentDocument?.URL,
    scrolled: (frame.contentWindow?.scrollY ?? 0) > 0,
  };
  frame.remove();
  return result;
}

describe("preview fragment links", () => {
  it("scrolls the preview instead of navigating it away", async () => {
    expect(await clickTheLink(withPreviewCsp(DOCUMENT, "about:srcdoc"))).toEqual({
      reloaded: false,
      url: "about:srcdoc#section",
      scrolled: true,
    });
  });

  // What the base element in the prologue exists to defeat. Without it a srcdoc
  // document resolves `#section` against the parent page's URL, so the click is a
  // cross-document navigation: the preview is torn down and the app's own URL is
  // loaded into a frame that has no origin to load it with, leaving the pane blank.
  it("would otherwise leave the preview for the parent page's URL", async () => {
    const result = await clickTheLink(`<!doctype html>${DOCUMENT}`);

    expect(result.reloaded).toBe(true);
    expect(result.url).toBe(`${window.location.href}#section`);
    expect(result.scrolled).toBe(false);
  });
});
