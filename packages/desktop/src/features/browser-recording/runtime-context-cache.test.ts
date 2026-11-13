import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SharedCdpSession, type CdpDebugger } from "../browser-automation/cdp-session-queue.js";

function setup() {
  const events = new EventEmitter();
  let attached = false;
  const client = {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    sendCommand: vi.fn().mockResolvedValue(undefined),
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
  } as CdpDebugger;
  const session = new SharedCdpSession(client);
  const send = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    events.emit("message", {}, method, params, sessionId);
  return { session, events, send };
}

describe("shared runtime context discovery", () => {
  it("replays existing contexts and retains them while another consumer owns Runtime", async () => {
    const { session, send } = setup();
    const automation = session.createConsumer({});
    const recording = session.createConsumer({});
    await automation.enableDomain("Runtime");
    send("Runtime.executionContextCreated", {
      context: { id: 3, name: "Electron Isolated Context", auxData: { frameId: "root" } },
    });
    send("Runtime.executionContextCreated", { context: { id: 4, name: "" } });
    await recording.enableDomain("Runtime");
    expect(session.runtimeContextSnapshot().contexts).toHaveLength(1);
    await recording.release();
    expect(session.runtimeContextSnapshot().contexts).toHaveLength(1);
    await automation.release();
    expect(session.runtimeContextSnapshot().contexts).toHaveLength(0);
  });
  it("removes child contexts on target detach and clears everything on debugger detach", async () => {
    const { session, events, send } = setup();
    const consumer = session.createConsumer({});
    await consumer.enableDomain("Runtime");
    send("Runtime.executionContextCreated", {
      context: { id: 1, name: "Electron Isolated Context" },
    });
    send(
      "Runtime.executionContextCreated",
      { context: { id: 1, name: "Electron Isolated Context" } },
      "child",
    );
    expect(session.runtimeContextSnapshot().contexts).toHaveLength(2);
    send("Target.detachedFromTarget", { sessionId: "child" });
    expect(session.runtimeContextSnapshot().contexts).toHaveLength(1);
    events.emit("detach", {}, "canceled_by_user");
    expect(session.runtimeContextSnapshot().contexts).toHaveLength(0);
  });
  it("bounds cached context count and reports overflow", () => {
    const { session, send } = setup();
    for (let id = 0; id < 2050; id++)
      send("Runtime.executionContextCreated", {
        context: { id, name: "Electron Isolated Context" },
      });
    const snapshot = session.runtimeContextSnapshot();
    expect(snapshot.contexts).toHaveLength(2048);
    expect(snapshot.dropped).toBe(2);
  });
});
