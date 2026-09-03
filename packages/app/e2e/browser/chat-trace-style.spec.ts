import path from "node:path";
import { test, expect } from "../support/fixtures";
import { awaitToolCall } from "../support/helpers/agent-stream";
import { openAgentRoute, seedRunningMockAgentWorkspace } from "../support/helpers/mock-agent";

/**
 * Capture for the trace transcript style (docs/refactors/chat-trace-presentation-plan.md,
 * slice 3). The fixture clears "@paseo:settings" on every navigation, so this seeds the key
 * afterwards — init scripts run in registration order.
 */

const EVIDENCE_DIR = path.resolve(process.cwd(), "../../qa-evidence/chat-trace");

test("renders a turn in the trace transcript style", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:settings", JSON.stringify({ chatTranscriptStyle: "trace" }));
  });

  const agent = await seedRunningMockAgentWorkspace({
    repoPrefix: "chat-trace-style-",
    title: "Chat trace style",
    model: "one-minute-stream",
    initialPrompt: "Stream a realistic turn for the trace transcript style capture.",
  });

  try {
    await openAgentRoute(page, agent);
    await awaitToolCall(page, /edit/i);

    // One segment per stream item, drawn by the wrapper that owns the gap between items. They
    // must form one unbroken line down the turn, or the style's whole point is lost. A per-node
    // rail cannot do this: the gap lives outside the node, so no amount of overshoot spans it.
    const rails = page.getByTestId("transcript-rail");
    await expect(rails.first()).toBeAttached();
    const boxes = [];
    for (let index = 0; index < (await rails.count()); index += 1) {
      const box = await rails.nth(index).boundingBox();
      if (box) {
        boxes.push(box);
      }
    }
    expect(boxes.length).toBeGreaterThan(1);
    const ordered = [...boxes].sort((a, b) => a.y - b.y);
    expect(new Set(ordered.map((box) => box.x)).size).toBe(1);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      expect(ordered[index].y).toBeLessThanOrEqual(previous.y + previous.height);
    }

    await page.screenshot({ path: path.join(EVIDENCE_DIR, "05-trace-turn.png"), fullPage: true });

    // Each node's marker has to sit on that node's FIRST line, not on its box. The offset is
    // built from the style that governs that line, so a heading-led node and a prose node need
    // different numbers — an assertion on one kind alone passes while the other floats.
    const dotDeltas = await page.evaluate(() => {
      function firstLineRect(root: Element): DOMRect | null {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          if ((node.textContent ?? "").trim().length > 0) {
            const rects = document.createRange();
            rects.selectNodeContents(node);
            const list = rects.getClientRects();
            if (list.length > 0) return list[0];
          }
          node = walker.nextNode();
        }
        return null;
      }
      const deltas: { kind: string; delta: number; text: string }[] = [];
      for (const dot of Array.from(
        document.querySelectorAll('[data-testid="transcript-node-dot"]'),
      )) {
        const host = dot.closest('[data-testid="assistant-message"],[data-testid="user-message"]');
        if (!host) continue;
        const line = firstLineRect(host);
        if (!line) continue;
        const dotRect = dot.getBoundingClientRect();
        deltas.push({
          kind: host.getAttribute("data-testid") ?? "",
          delta: dotRect.top + dotRect.height / 2 - (line.top + line.height / 2),
          text: (host.textContent ?? "").trim().slice(0, 40),
        });
      }
      return deltas;
    });

    expect(dotDeltas.length).toBeGreaterThan(2);
    // A heading-led node is what catches an offset derived from the body line height alone.
    expect(dotDeltas.some((entry) => entry.kind === "user-message")).toBe(true);
    for (const entry of dotDeltas) {
      // 4px covers the half-pixel rounding and the list wrapper's own padding, which the offset
      // does not model. Anything larger reads as a floating dot.
      expect(Math.abs(entry.delta), `${entry.kind}: ${entry.text}`).toBeLessThanOrEqual(4);
    }

    // Under "cards" the bubble is right-aligned and narrower than the column; trace flips it to
    // a full-width outline on the same left edge as every other node.
    const userMessage = page.getByTestId("user-message").first();
    await userMessage.scrollIntoViewIfNeeded();
    await expect(userMessage).toBeVisible();
    const messageBox = await userMessage.boundingBox();
    const bubbleBox = await page.getByTestId("user-message-bubble").first().boundingBox();
    expect(messageBox).not.toBeNull();
    expect(bubbleBox).not.toBeNull();
    if (messageBox && bubbleBox) {
      // The bubble starts just right of the rail, like every other node's content, and fills the
      // rest of the column instead of hugging the right edge as the "cards" bubble does.
      expect(bubbleBox.x).toBeGreaterThan(boxes[0].x);
      expect(bubbleBox.x - boxes[0].x).toBeLessThan(24);
      expect(bubbleBox.width).toBeGreaterThan((messageBox.width - 24) * 0.9);
    }
    await userMessage.screenshot({ path: path.join(EVIDENCE_DIR, "06-trace-user-message.png") });

    // IN and OUT must live in one horizontal scroller, or a wide command would scroll away from
    // its output and the two columns would drift apart. The mock command is deliberately wider
    // than the card so the overflow is real rather than a viewport trick — narrowing the window
    // swaps the card for the compact sheet instead of overflowing it.
    const shellProbe = async () =>
      page.evaluate(() => {
        const label = [...document.querySelectorAll<HTMLElement>("*")].find(
          (node) => node.children.length === 0 && node.textContent?.trim() === "IN",
        );
        if (!label) {
          return null;
        }
        let scroller: HTMLElement | null = label.parentElement;
        while (scroller && getComputedStyle(scroller).overflowX === "visible") {
          scroller = scroller.parentElement;
        }
        if (!scroller) {
          return null;
        }
        const outLabel = [...scroller.querySelectorAll<HTMLElement>("*")].find(
          (node) => node.children.length === 0 && node.textContent?.trim() === "OUT",
        );
        return {
          scrollWidth: scroller.scrollWidth,
          clientWidth: scroller.clientWidth,
          outInsideSameScroller: Boolean(outLabel),
        };
      });

    const wide = await shellProbe();
    expect(wide).not.toBeNull();
    // Both streams live in one scroller, so one scroll position moves both.
    expect(wide?.outInsideSameScroller).toBe(true);
    expect(wide?.scrollWidth).toBeGreaterThan(wide?.clientWidth ?? 0);

    // The pill sits on the preview and says "Click to expand", so the preview is what a reader
    // aims at. It is also `pointerEvents: none`, so the press has to land on the card under it.
    const preview = page
      .getByTestId("tool-call-detail")
      .filter({ hasText: "Click to expand" })
      .first();
    await expect(preview).toBeVisible();
    const collapsedBox = await preview.boundingBox();
    expect(collapsedBox).not.toBeNull();
    await preview.click({ position: { x: 12, y: 12 } });
    await expect(preview.getByText("Click to expand")).toHaveCount(0);
    const expandedBox = await preview.boundingBox();
    expect(expandedBox?.height ?? 0).toBeGreaterThan(collapsedBox?.height ?? 0);
  } finally {
    await agent.cleanup();
  }
});
