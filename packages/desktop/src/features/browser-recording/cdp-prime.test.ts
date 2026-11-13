import { describe, expect, it, vi } from "vitest";
import { SharedCdpSession, type CdpDebugger } from "../browser-automation/cdp-session-queue.js";

describe("early popup CDP setup", () => {
  it("rejects a prime when the debugger detaches during setup", async () => {
    let attached = false;
    let detach: (() => void) | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const client = {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      sendCommand: vi.fn().mockReturnValue(pending),
      on: (event: string, listener: () => void) => {
        if (event === "detach") detach = listener;
      },
    } as CdpDebugger;
    const session = new SharedCdpSession(client);
    const primed = session.primeDomain(session.createConsumer({}), "Network");
    attached = false;
    detach?.();
    finish();
    await expect(primed).rejects.toThrow("detached");
  });

  it("rolls back a failed prime so another attempt can enable the domain", async () => {
    let attached = false;
    const sendCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("setup failed"))
      .mockResolvedValue(undefined);
    const client: CdpDebugger = {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      sendCommand,
    };
    const session = new SharedCdpSession(client);
    const consumer = session.createConsumer({});
    await expect(session.primeDomain(consumer, "Network")).rejects.toThrow("setup failed");
    await consumer.enableDomain("Network");
    expect(sendCommand).toHaveBeenCalledTimes(2);
    await consumer.release();
  });

  it("starts Network before returning and shares ownership with later consumers", async () => {
    let attached = false;
    let complete!: () => void;
    const initial = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const sendCommand = vi.fn().mockReturnValueOnce(initial).mockResolvedValue(undefined);
    const client: CdpDebugger = {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      sendCommand,
    };
    const session = new SharedCdpSession(client);
    const first = session.createConsumer({});
    const primed = session.primeDomain(first, "Network");
    expect(attached).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith("Network.enable", {});
    const second = session.createConsumer({});
    const enabled = second.enableDomain("Network");
    complete();
    await Promise.all([primed, enabled]);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    await first.release();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    await second.release();
    expect(sendCommand).toHaveBeenLastCalledWith("Network.disable", {}, undefined);
  });
});
