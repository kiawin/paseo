import { test, expect } from "../support/fixtures";
import { OWNED_ID, openArtifactsPanel, stubArtifactRpcs } from "../support/helpers/artifacts";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

/**
 * An agent-published document with a table of contents, which is what makes this regression
 * easy to hit: the artifact viewer is a list of deliverables meant to be read, and a long one
 * arrives with internal links.
 *
 * The web preview renders through `srcDoc`, and a srcdoc document inherits the *parent page's*
 * base URL. Without a base of its own, `#findings` resolved against the Paseo app's URL, so the
 * click was a cross-document navigation: the preview was torn down and the app's own URL was
 * loaded into a frame with no origin to load it with, leaving the pane blank.
 */
const DOCUMENT = `<!doctype html>
<h1 id="summary">Q3 revenue dashboard</h1>
<nav><a id="toc-findings" href="#findings">Jump to findings</a></nav>
<p style="margin-bottom:1600px">Revenue grew across every region.</p>
<h2 id="findings">Findings</h2>
<p style="margin-bottom:1600px">Enterprise renewals carried the quarter.</p>`;

test("a table-of-contents link scrolls the artifact instead of blanking the pane", async ({
  page,
  withWorkspace,
}) => {
  await stubArtifactRpcs(page, { html: DOCUMENT });
  const workspace = await withWorkspace({ prefix: "artifact-fragment-link-" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await waitForWorkspaceTabsVisible(page);

  await openArtifactsPanel(page);
  const list = page.getByTestId("artifacts-list").filter({ visible: true }).first();
  await expect(list).toBeVisible({ timeout: 30_000 });
  await list.getByTestId(`artifact-row-${OWNED_ID}`).click();

  const preview = page.getByTestId("artifact-html-preview").filter({ visible: true }).first();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  const body = preview.contentFrame().locator("body");
  await expect(preview.contentFrame().locator("#summary")).toHaveText("Q3 revenue dashboard");
  expect(await body.evaluate((element) => element.ownerDocument.URL)).toBe("about:srcdoc");

  await preview.contentFrame().locator("#toc-findings").click();

  // The document is still the one the daemon sent, it is still at its own URL, and it moved.
  // On the broken build the URL here is the app's own, and nothing is left to assert against.
  await expect(preview.contentFrame().locator("#summary")).toHaveText("Q3 revenue dashboard");
  await expect
    .poll(async () => body.evaluate((element) => element.ownerDocument.URL), { timeout: 5_000 })
    .toBe("about:srcdoc#findings");
  expect(
    await body.evaluate((element) => element.ownerDocument.defaultView?.scrollY ?? 0),
  ).toBeGreaterThan(0);
});
