import { describe, expect, test, vi } from "vitest";
import { executeAutomationCommand, type BrowserRegistry, type TabImage } from "./service.js";
import { adaptWebContents, HostSnapshotEngineRegistry } from "./ipc.js";
import * as browserAutomationIpc from "./ipc.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";

class FakeImage implements TabImage {
  public toPNG(): Uint8Array {
    return new Uint8Array([137, 80, 78, 71]);
  }

  public getSize(): { width: number; height: number } {
    return { width: 640, height: 480 };
  }
}

class FakeDebugger {
  public attachedProtocolVersions: string[] = [];
  public commands: Array<{ command: string; params: Record<string, unknown>; sessionId?: string }> =
    [];
  public blockCommands = false;
  public failAttach = false;
  public readonly blockedCommandNames = new Set<string>();
  public readonly failedCommandNames = new Set<string>();
  public readonly failedCommandErrors = new Map<string, Error>();
  public readonly promptDialogs: unknown[] = [];
  public failPromptDrain = false;
  public beforeCommand: ((command: string) => void) | null = null;
  private readonly messageListeners = new Set<
    (event: unknown, method: string, params?: Record<string, unknown>, sessionId?: string) => void
  >();
  private readonly detachListeners = new Set<(event?: unknown, reason?: string) => void>();
  private readonly blockedCommands: Array<() => void> = [];

  public isAttached(): boolean {
    return this.attachedProtocolVersions.length > 0;
  }

  public attach(protocolVersion?: string): void {
    if (this.failAttach) throw new Error("debugger unavailable");
    this.attachedProtocolVersions.push(protocolVersion ?? "");
  }

  public async sendCommand(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    this.commands.push({ command, params: params ?? {}, ...(sessionId ? { sessionId } : {}) });
    this.beforeCommand?.(command);
    const commandError = this.failedCommandErrors.get(command);
    if (commandError) {
      throw commandError;
    }
    if (this.failedCommandNames.has(command)) {
      throw new Error(`${command} failed`);
    }
    if (this.blockCommands || this.blockedCommandNames.has(command)) {
      await new Promise<void>((resolve) => {
        this.blockedCommands.push(resolve);
      });
    }
    if (command === "Runtime.evaluate" && typeof params?.expression === "string") {
      if (params.expression.includes("state.prompts.splice(0)")) {
        if (this.failPromptDrain) {
          throw new Error("execution context destroyed");
        }
        return { result: { value: this.promptDialogs.splice(0) } };
      }
      return { result: { value: true } };
    }
    return { ok: true };
  }

  public on(
    event: "message" | "detach",
    listener:
      | ((
          event: unknown,
          method: string,
          params?: Record<string, unknown>,
          sessionId?: string,
        ) => void)
      | (() => void),
  ): void {
    if (event === "detach") {
      this.detachListeners.add(listener as (event?: unknown, reason?: string) => void);
      return;
    }
    this.messageListeners.add(
      listener as (
        event: unknown,
        method: string,
        params?: Record<string, unknown>,
        sessionId?: string,
      ) => void,
    );
  }

  public removeListener(
    event: "message" | "detach",
    listener:
      | ((
          event: unknown,
          method: string,
          params?: Record<string, unknown>,
          sessionId?: string,
        ) => void)
      | ((event?: unknown, reason?: string) => void),
  ): void {
    if (event === "detach") {
      this.detachListeners.delete(listener as (event?: unknown, reason?: string) => void);
      return;
    }
    this.messageListeners.delete(
      listener as (
        event: unknown,
        method: string,
        params?: Record<string, unknown>,
        sessionId?: string,
      ) => void,
    );
  }

  public emitMessage(method: string, params?: Record<string, unknown>, sessionId?: string): void {
    if (this.messageListeners.size === 0) {
      throw new Error("Debugger message listener was not registered");
    }
    for (const listener of this.messageListeners) listener({}, method, params, sessionId);
  }

  public emitDetach(reason?: string): void {
    this.attachedProtocolVersions.length = 0;
    for (const listener of this.detachListeners) listener({}, reason);
  }

  public finishNextCommand(): void {
    const resolve = this.blockedCommands.shift();
    if (!resolve) {
      throw new Error("No command is blocked");
    }
    resolve();
  }
}

type ConsoleMessageListener = (
  event: unknown,
  level: unknown,
  message: unknown,
  line: unknown,
  sourceId: unknown,
) => void;

class FakeWebContents {
  public backgroundThrottling = true;
  public getBackgroundThrottling(): boolean {
    return this.backgroundThrottling;
  }
  public setBackgroundThrottling(allowed: boolean): void {
    if (this.destroyed) throw new Error("Object has been destroyed");
    this.backgroundThrottling = allowed;
  }
  public readonly debugger = new FakeDebugger();
  public readonly inputEvents: IsolatedKeyboardInputEvent[] = [];
  public readonly loadedUrls: string[] = [];
  public frameListener: ((image: TabImage) => void) | null = null;
  public endedFrameSubscriptions = 0;
  public readonly invalidations: string[] = [];
  private consoleMessageListener: ConsoleMessageListener | null = null;
  public readonly destroyedListeners = new Set<() => void>();
  public destroyed = false;

  public constructor(private readonly webContentsId: number) {}

  public get id(): number {
    if (this.destroyed) {
      throw new TypeError("Object has been destroyed");
    }
    return this.webContentsId;
  }

  public getURL(): string {
    return "https://example.com";
  }

  public getTitle(): string {
    return "Example";
  }

  public canGoBack(): boolean {
    return false;
  }

  public canGoForward(): boolean {
    return false;
  }

  public isLoading(): boolean {
    return false;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public async executeJavaScript(): Promise<unknown> {
    return null;
  }

  public async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
  }

  public goBack(): void {}

  public goForward(): void {}

  public reload(): void {}

  public beginFrameSubscription(onlyDirty: boolean, callback: (image: TabImage) => void): void {
    expect(onlyDirty).toBe(false);
    this.frameListener = callback;
  }

  public endFrameSubscription(): void {
    this.frameListener = null;
    this.endedFrameSubscriptions += 1;
  }

  public invalidate(): void {
    this.invalidations.push("invalidate");
  }

  public sendInputEvent(event: IsolatedKeyboardInputEvent): void {
    this.inputEvents.push(event);
  }

  public async insertText(_text: string): Promise<void> {}

  public on(event: "console-message", listener: ConsoleMessageListener): void {
    expect(event).toBe("console-message");
    this.consoleMessageListener = listener;
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.add(listener);
  }

  public removeListener(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.delete(listener);
  }

  public emitConsoleMessage(input: {
    level: unknown;
    message: unknown;
    line: unknown;
    sourceId: unknown;
  }): void {
    if (!this.consoleMessageListener) {
      throw new Error("Console listener was not registered");
    }
    this.consoleMessageListener({}, input.level, input.message, input.line, input.sourceId);
  }

  public destroy(): void {
    this.destroyed = true;
    this.debugger.emitDetach();
    this.frameListener = null;
    for (const listener of this.destroyedListeners) {
      this.destroyedListeners.delete(listener);
      listener();
    }
  }
}

describe("browser automation IPC adapter", () => {
  test("shares debugger domains and child-session events between independent consumers", async () => {
    const contents = new FakeWebContents(801);
    const tab = adaptWebContents(contents);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const first = shared.createConsumer({ onMessage: (message) => firstEvents.push(message) });
    const second = shared.createConsumer({ onMessage: (message) => secondEvents.push(message) });

    await Promise.all([first.enableDomain("Network"), second.enableDomain("Network")]);
    expect(
      contents.debugger.commands.filter((item) => item.command === "Network.enable"),
    ).toHaveLength(1);
    contents.debugger.emitMessage("Network.requestWillBeSent", { requestId: "one" }, "child-1");
    expect(firstEvents).toEqual([
      { method: "Network.requestWillBeSent", params: { requestId: "one" }, sessionId: "child-1" },
    ]);
    expect(secondEvents).toEqual(firstEvents);
    await first.sendCommand("Runtime.evaluate", { expression: "1" }, "child-1");
    expect(contents.debugger.commands.at(-1)).toEqual({
      command: "Runtime.evaluate",
      params: { expression: "1" },
      sessionId: "child-1",
    });

    await first.release();
    expect(contents.debugger.commands.some((item) => item.command === "Network.disable")).toBe(
      false,
    );
    contents.debugger.emitMessage("Network.loadingFinished", { requestId: "one" }, "child-1");
    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(2);
    await second.release();
    expect(
      contents.debugger.commands.filter((item) => item.command === "Network.disable"),
    ).toHaveLength(1);
    await expect(tab.sendDebugCommand?.("Runtime.evaluate", { expression: "2" })).resolves.toEqual({
      result: { value: true },
    });
    expect(contents.debugger.attachedProtocolVersions).toEqual(["1.3"]);
    contents.destroy();
  });

  test("reports a debugger detach once to each consumer and restores enabled domains on reattach", async () => {
    const contents = new FakeWebContents(802);
    adaptWebContents(contents);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const firstDetach = vi.fn();
    const secondDetach = vi.fn();
    const first = shared.createConsumer({ onDetach: firstDetach });
    const second = shared.createConsumer({ onDetach: secondDetach });
    await first.enableDomain("Network");
    await second.enableDomain("Network");
    await first.enableDomain("Page", "obsolete-child");

    contents.debugger.emitDetach("devtools-opened");
    expect(firstDetach).toHaveBeenCalledTimes(1);
    expect(secondDetach).toHaveBeenCalledTimes(1);
    expect(firstDetach).toHaveBeenCalledWith("devtools-opened");
    await first.sendCommand("Runtime.evaluate", { expression: "3" });
    expect(
      contents.debugger.commands.filter((item) => item.command === "Network.enable"),
    ).toHaveLength(2);
    expect(
      contents.debugger.commands.filter(
        (item) => item.command === "Page.enable" && item.sessionId === "obsolete-child",
      ),
    ).toHaveLength(1);
    await first.release();
    await second.release();
    contents.destroy();
  });

  test("continues dispatching when another consumer callback throws", async () => {
    const contents = new FakeWebContents(804);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = shared.createConsumer({
      onMessage: () => {
        throw new Error("consumer failure");
      },
    });
    const received = vi.fn();
    const second = shared.createConsumer({ onMessage: received });
    await first.enableDomain("Network");
    contents.debugger.emitMessage("Network.loadingFinished", { requestId: "one" });
    expect(received).toHaveBeenCalledOnce();
    await first.release();
    await second.release();
    warn.mockRestore();
    contents.destroy();
  });

  test("does not disable the dialog domain when a recording consumer stops", async () => {
    const contents = new FakeWebContents(803);
    const tab = adaptWebContents(contents);
    await tab.captureDialogs?.(async () => undefined);
    const recorder = browserAutomationIpc.getSharedCdpSession(contents).createConsumer({});
    await recorder.enableDomain("Page");
    await recorder.release();
    expect(
      contents.debugger.commands.filter((item) => item.command === "Page.enable"),
    ).toHaveLength(1);
    expect(contents.debugger.commands.some((item) => item.command === "Page.disable")).toBe(false);
    await expect(tab.captureDialogs?.(async () => "still works")).resolves.toEqual({
      result: "still works",
      dialogs: [],
    });
    contents.destroy();
  });

  test("isolates a failed recorder recovery from automation and reports recovery failure", async () => {
    const contents = new FakeWebContents(805);
    const tab = adaptWebContents(contents);
    const recorder = browserAutomationIpc.getSharedCdpSession(contents).createConsumer({});
    await recorder.enableDomain("Network");
    contents.debugger.emitDetach("devtools-opened");
    contents.debugger.failAttach = true;
    await expect(recorder.recover()).rejects.toThrow("debugger unavailable");
    contents.debugger.failAttach = false;
    contents.debugger.failedCommandNames.add("Network.enable");
    await expect(tab.sendDebugCommand?.("Runtime.evaluate", { expression: "1" })).resolves.toEqual({
      result: { value: true },
    });
    await expect(recorder.recover()).rejects.toThrow("Network.enable failed");
    contents.debugger.failedCommandNames.clear();
    await recorder.recover();
    await recorder.release();
    contents.destroy();
  });

  test("cleans every owned domain even if one disable command fails", async () => {
    const contents = new FakeWebContents(806);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const recorder = shared.createConsumer({});
    await recorder.enableDomain("Network");
    await recorder.enableDomain("Page");
    contents.debugger.failedCommandNames.add("Network.disable");
    await expect(recorder.release()).rejects.toThrow("Network.disable failed");
    expect(contents.debugger.commands.some((entry) => entry.command === "Page.disable")).toBe(true);
    contents.debugger.failedCommandNames.clear();
    const next = shared.createConsumer({});
    await next.enableDomain("Page");
    await next.release();
    contents.destroy();
  });

  test("ignores child-session dialog events while handling a root dialog once", async () => {
    const contents = new FakeWebContents(807);
    const tab = adaptWebContents(contents);
    const recorder = browserAutomationIpc.getSharedCdpSession(contents).createConsumer({});
    await recorder.enableDomain("Page", "child");
    const result = await tab.captureDialogs?.(async () => {
      contents.debugger.emitMessage(
        "Page.javascriptDialogOpening",
        { type: "confirm", message: "child" },
        "child",
      );
      contents.debugger.emitMessage("Page.javascriptDialogOpening", {
        type: "confirm",
        message: "root",
      });
      await flushMicrotasks();
      return "done";
    });
    expect(result?.dialogs.map((entry) => entry.message)).toEqual(["root"]);
    expect(
      contents.debugger.commands.filter((entry) => entry.command === "Page.handleJavaScriptDialog"),
    ).toHaveLength(1);
    await recorder.release();
    contents.destroy();
  });

  test("shares target auto-attach ownership and rejects raw domain toggles", async () => {
    const contents = new FakeWebContents(808);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const first = shared.createConsumer({});
    const second = shared.createConsumer({});
    await first.enableAutoAttach();
    await second.enableAutoAttach();
    expect(
      contents.debugger.commands.filter(
        (entry) => entry.command === "Target.setAutoAttach" && entry.params.autoAttach === true,
      ),
    ).toHaveLength(1);
    await expect(first.sendCommand("Network.disable")).rejects.toThrow("ownership");
    await expect(first.sendCommand("Target.setAutoAttach", { autoAttach: false })).rejects.toThrow(
      "ownership",
    );
    await first.release();
    expect(
      contents.debugger.commands.some(
        (entry) => entry.command === "Target.setAutoAttach" && entry.params.autoAttach === false,
      ),
    ).toBe(false);
    await second.release();
    expect(
      contents.debugger.commands.filter(
        (entry) => entry.command === "Target.setAutoAttach" && entry.params.autoAttach === false,
      ),
    ).toHaveLength(1);
    contents.destroy();
  });

  test("forgets detached child sessions without disabling or restoring their stale IDs", async () => {
    const contents = new FakeWebContents(809);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const recorder = shared.createConsumer({});
    await recorder.enableDomain("Network", "old-child");
    contents.debugger.emitMessage("Target.detachedFromTarget", { sessionId: "old-child" });
    await recorder.sendCommand("Runtime.evaluate", { expression: "1" });
    await recorder.release();
    expect(
      contents.debugger.commands.filter(
        (entry) => entry.command === "Network.enable" && entry.sessionId === "old-child",
      ),
    ).toHaveLength(1);
    expect(
      contents.debugger.commands.some(
        (entry) => entry.command === "Network.disable" && entry.sessionId === "old-child",
      ),
    ).toBe(false);
    contents.destroy();
  });

  test("serializes domain setup with commands and rejects use after destruction", async () => {
    const contents = new FakeWebContents(810);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const recorder = shared.createConsumer({});
    contents.debugger.blockedCommandNames.add("Network.enable");
    const enabled = recorder.enableDomain("Network");
    const command = recorder.sendCommand("Runtime.evaluate", { expression: "1" });
    await flushMicrotasks();
    expect(contents.debugger.commands.map((entry) => entry.command)).toEqual(["Network.enable"]);
    contents.debugger.blockedCommandNames.clear();
    contents.debugger.finishNextCommand();
    await enabled;
    await command;
    expect(contents.debugger.commands.map((entry) => entry.command)).toEqual([
      "Network.enable",
      "Runtime.evaluate",
    ]);
    contents.destroy();
    await expect(recorder.recover()).rejects.toThrow("closed");
    expect(() => shared.createConsumer({})).toThrow("disposed");
    expect(() => contents.debugger.emitMessage("Network.loadingFinished")).toThrow(
      "listener was not registered",
    );
  });

  test("shares identical domain settings and rejects conflicting consumer settings", async () => {
    const contents = new FakeWebContents(811);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const first = shared.createConsumer({});
    const second = shared.createConsumer({});
    await first.enableDomain("Network", undefined, { maxTotalBufferSize: 4096 });
    await second.enableDomain("Network", undefined, { maxTotalBufferSize: 4096 });
    await expect(
      second.enableDomain("Network", undefined, { maxTotalBufferSize: 1024 }),
    ).rejects.toThrow("settings");
    expect(
      contents.debugger.commands.filter((entry) => entry.command === "Network.enable"),
    ).toEqual([{ command: "Network.enable", params: { maxTotalBufferSize: 4096 } }]);
    await first.release();
    await second.release();
    contents.destroy();
  });

  test("does not create a shared session for destroyed browser contents", () => {
    const contents = new FakeWebContents(814);
    contents.destroy();
    expect(() => browserAutomationIpc.getSharedCdpSession(contents)).toThrow();
    expect(() => contents.debugger.emitMessage("Network.loadingFinished")).toThrow(
      "listener was not registered",
    );
  });

  test("releases a detached consumer without restoring or disabling its domain", async () => {
    const contents = new FakeWebContents(812);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const recorder = shared.createConsumer({});
    await recorder.enableDomain("Network");
    contents.debugger.emitDetach("devtools-opened");
    await recorder.release();
    expect(
      contents.debugger.commands.filter((entry) => entry.command === "Network.enable"),
    ).toHaveLength(1);
    expect(contents.debugger.commands.some((entry) => entry.command === "Network.disable")).toBe(
      false,
    );
    contents.destroy();
  });

  test("an immediate dialog response after detach leaves domain recovery explicit", async () => {
    const contents = new FakeWebContents(813);
    const shared = browserAutomationIpc.getSharedCdpSession(contents);
    const recorder = shared.createConsumer({});
    await recorder.enableDomain("Network");
    contents.debugger.emitDetach("devtools-opened");
    await shared.sendImmediate("Page.handleJavaScriptDialog", { accept: false });
    expect(contents.debugger.commands.map((entry) => entry.command)).toEqual([
      "Network.enable",
      "Page.handleJavaScriptDialog",
    ]);
    await recorder.recover();
    expect(contents.debugger.commands.map((entry) => entry.command)).toEqual([
      "Network.enable",
      "Page.handleJavaScriptDialog",
      "Network.enable",
    ]);
    await recorder.release();
    contents.destroy();
  });

  test("isolates snapshot refs by host window and releases them on destruction", () => {
    const registry = new HostSnapshotEngineRegistry();
    const firstHost = new FakeHostWebContents(1);
    const secondHost = new FakeHostWebContents(2);

    const firstEngine = registry.get(firstHost);
    expect(registry.get(firstHost)).toBe(firstEngine);
    expect(registry.get(secondHost)).not.toBe(firstEngine);

    firstHost.destroy();
    expect(registry.get(new FakeHostWebContents(1))).not.toBe(firstEngine);
  });

  test("sends contained keyboard input directly to the guest", () => {
    const contents = new FakeWebContents(19);
    const tab = adaptWebContents(contents);

    tab.sendInputEvent({ type: "keyDown", keyCode: "Enter", skipIfUnhandled: true });

    expect(contents.inputEvents).toEqual([
      { type: "keyDown", keyCode: "Enter", skipIfUnhandled: true },
    ]);
  });

  test("captures one rendered frame and releases the subscription", async () => {
    const contents = new FakeWebContents(20);
    const tab = adaptWebContents(contents);
    const controller = new AbortController();
    const capture = tab.captureFrame(controller.signal);
    contents.frameListener?.(new FakeImage());

    expect((await capture).getSize()).toEqual({ width: 640, height: 480 });
    expect(contents.frameListener).toBeNull();
    controller.abort();
    expect(contents.endedFrameSubscriptions).toBe(1);
  });

  test("cancels a pending frame subscription when the capture budget expires", async () => {
    const contents = new FakeWebContents(2001);
    const tab = adaptWebContents(contents);
    const controller = new AbortController();
    const capture = tab.captureFrame(controller.signal);
    const failure = expect(capture).rejects.toThrow("capture deadline");
    controller.abort(new Error("capture deadline"));

    await failure;
    expect(contents.frameListener).toBeNull();
    expect(contents.endedFrameSubscriptions).toBe(1);
  });

  test("closing a guest settles its screenshot and releases the next queued capture", async () => {
    vi.useFakeTimers();
    try {
      const closing = new FakeWebContents(2002);
      const next = new FakeWebContents(2003);
      const tabs = new Map([
        ["closing", adaptWebContents(closing)],
        ["next", adaptWebContents(next)],
      ]);
      const registry: BrowserRegistry = {
        listRegisteredBrowserIds: () => [...tabs.keys()],
        listRegisteredBrowserIdsForWorkspace: () => [...tabs.keys()],
        getTabContents: (id) => tabs.get(id) ?? null,
        getBrowserWorkspaceId: () => null,
        getWorkspaceActiveBrowserId: () => null,
      };
      const capture = (browserId: string) =>
        executeAutomationCommand(
          {
            type: "browser.automation.execute.request",
            requestId: browserId,
            command: { command: "screenshot", args: { browserId, fullPage: false } },
          },
          registry,
        );
      let closedResult: unknown;
      const closedCapture = Promise.resolve(capture("closing")).then((result) => {
        closedResult = result;
        return result;
      });
      const nextCapture = capture("next");
      await vi.advanceTimersByTimeAsync(0);
      expect(closing.frameListener).not.toBeNull();
      closing.destroy();
      await vi.advanceTimersByTimeAsync(0);
      expect(closedResult).toEqual({
        requestId: "closing",
        ok: false,
        error: {
          code: "browser_tab_closed",
          message: "Browser tab closing has been closed",
          retryable: false,
        },
      });
      expect(closing.destroyedListeners.size).toBe(0);
      expect(next.frameListener).not.toBeNull();
      next.frameListener?.(new FakeImage());
      await expect(nextCapture).resolves.toMatchObject({ ok: true });
      await closedCapture;
      expect(next.destroyedListeners.size).toBe(1);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  test("collects console messages until the guest is destroyed", () => {
    const contents = new FakeWebContents(21);
    const tab = adaptWebContents(contents);

    contents.emitConsoleMessage({
      level: "warning",
      message: "hello",
      line: 12,
      sourceId: "https://example.com/app.js",
    });

    expect(tab.getConsoleMessages?.()).toEqual([
      {
        level: "warning",
        message: "hello",
        line: 12,
        source: "https://example.com/app.js",
        timestamp: expect.any(Number),
      },
    ]);

    expect(() => contents.destroy()).not.toThrow();

    expect(tab.getConsoleMessages?.()).toEqual([]);
  });

  test("attaches the debugger before sending a CDP command", async () => {
    const contents = new FakeWebContents(22);
    const tab = adaptWebContents(contents);

    const result = await tab.sendDebugCommand?.("Page.captureScreenshot", {
      format: "png",
    });

    expect(result).toEqual({ ok: true });
    expect(contents.debugger.attachedProtocolVersions).toEqual(["1.3"]);
    expect(contents.debugger.commands).toEqual([
      { command: "Page.captureScreenshot", params: { format: "png" } },
    ]);
  });

  test("serializes CDP commands per guest contents", async () => {
    const contents = new FakeWebContents(23);
    contents.debugger.blockCommands = true;
    const tab = adaptWebContents(contents);

    const first = tab.sendDebugCommand?.("Input.dispatchMouseEvent", { type: "mouseMoved" });
    const second = tab.sendDebugCommand?.("Page.captureScreenshot", { format: "png" });
    await flushMicrotasks();

    expect(contents.debugger.commands).toEqual([
      { command: "Input.dispatchMouseEvent", params: { type: "mouseMoved" } },
    ]);

    contents.debugger.finishNextCommand();
    await flushMicrotasks();

    expect(contents.debugger.commands).toEqual([
      { command: "Input.dispatchMouseEvent", params: { type: "mouseMoved" } },
      { command: "Page.captureScreenshot", params: { format: "png" } },
    ]);

    contents.debugger.finishNextCommand();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  test("handles JavaScript dialogs through the per-tab CDP queue", async () => {
    const contents = new FakeWebContents(24);
    const tab = adaptWebContents(contents);

    const captured = tab.captureDialogs?.(async () => {
      contents.debugger.blockCommands = true;
      const input = tab.sendDebugCommand?.("Input.dispatchMouseEvent", { type: "mouseReleased" });
      await flushMicrotasks();

      contents.debugger.emitMessage("Page.javascriptDialogOpening", {
        type: "confirm",
        message: "Delete item?",
      });
      await flushMicrotasks();

      expect(contents.debugger.commands).toEqual([
        { command: "Page.enable", params: {} },
        {
          command: "Runtime.evaluate",
          params: { expression: expect.any(String), returnByValue: true },
        },
        { command: "Input.dispatchMouseEvent", params: { type: "mouseReleased" } },
        { command: "Page.handleJavaScriptDialog", params: { accept: false } },
      ]);

      contents.debugger.blockCommands = false;
      contents.debugger.finishNextCommand();
      await input;
      await flushMicrotasks();
      return "done";
    });

    await expect(captured).resolves.toEqual({
      result: "done",
      dialogs: [
        {
          type: "confirm",
          message: "Delete item?",
          action: "dismissed",
          timestamp: expect.any(Number),
        },
      ],
    });
    expect(contents.debugger.commands).toEqual([
      { command: "Page.enable", params: {} },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
      { command: "Input.dispatchMouseEvent", params: { type: "mouseReleased" } },
      { command: "Page.handleJavaScriptDialog", params: { accept: false } },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
    ]);
  });

  test("handles JavaScript dialogs while the triggering CDP input command is still in flight", async () => {
    const contents = new FakeWebContents(25);
    const tab = adaptWebContents(contents);

    const captured = tab.captureDialogs?.(async () => {
      contents.debugger.blockedCommandNames.add("Input.dispatchMouseEvent");
      const input = tab.sendDebugCommand?.("Input.dispatchMouseEvent", { type: "mousePressed" });
      await flushMicrotasks();

      contents.debugger.emitMessage("Page.javascriptDialogOpening", {
        type: "alert",
        message: "Saved",
      });
      await flushMicrotasks();

      expect(contents.debugger.commands).toEqual([
        { command: "Page.enable", params: {} },
        {
          command: "Runtime.evaluate",
          params: { expression: expect.any(String), returnByValue: true },
        },
        { command: "Input.dispatchMouseEvent", params: { type: "mousePressed" } },
        { command: "Page.handleJavaScriptDialog", params: { accept: true } },
      ]);

      contents.debugger.blockedCommandNames.clear();
      contents.debugger.finishNextCommand();
      await input;
      return "done";
    });

    await expect(captured).resolves.toEqual({
      result: "done",
      dialogs: [
        {
          type: "alert",
          message: "Saved",
          action: "accepted",
          timestamp: expect.any(Number),
        },
      ],
    });
    expect(contents.debugger.commands.at(-1)).toEqual({
      command: "Runtime.evaluate",
      params: {
        expression: expect.stringContaining("delete window[stateKey]"),
        returnByValue: true,
      },
    });
  });

  test("keeps the prompt shim installed until overlapping captures finish", async () => {
    const contents = new FakeWebContents(26);
    const tab = adaptWebContents(contents);
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const finishFirst = deferred<void>();
    const finishSecond = deferred<void>();

    const first = tab.captureDialogs?.(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
      return "first";
    });
    await firstStarted.promise;

    const second = tab.captureDialogs?.(async () => {
      secondStarted.resolve();
      await finishSecond.promise;
      return "second";
    });
    await secondStarted.promise;

    contents.debugger.promptDialogs.push(
      {
        type: "prompt",
        message: "First?",
        defaultValue: "one",
        action: "dismissed",
        timestamp: 1,
      },
      {
        type: "prompt",
        message: "Second?",
        defaultValue: "two",
        action: "dismissed",
        timestamp: 2,
      },
    );

    finishFirst.resolve();
    await expect(first).resolves.toEqual({
      result: "first",
      dialogs: [
        {
          type: "prompt",
          message: "First?",
          defaultValue: "one",
          action: "dismissed",
          timestamp: 1,
        },
        {
          type: "prompt",
          message: "Second?",
          defaultValue: "two",
          action: "dismissed",
          timestamp: 2,
        },
      ],
    });
    expect(
      contents.debugger.commands.some(
        (entry) =>
          entry.command === "Runtime.evaluate" &&
          typeof entry.params.expression === "string" &&
          entry.params.expression.includes("delete window[stateKey]"),
      ),
    ).toBe(false);

    finishSecond.resolve();
    await expect(second).resolves.toEqual({
      result: "second",
      dialogs: [
        {
          type: "prompt",
          message: "First?",
          defaultValue: "one",
          action: "dismissed",
          timestamp: 1,
        },
        {
          type: "prompt",
          message: "Second?",
          defaultValue: "two",
          action: "dismissed",
          timestamp: 2,
        },
      ],
    });
    expect(contents.debugger.commands.at(-1)).toEqual({
      command: "Runtime.evaluate",
      params: {
        expression: expect.stringContaining("delete window[stateKey]"),
        returnByValue: true,
      },
    });
  });

  test("leaves JavaScript dialogs alone when no capture is active", async () => {
    const contents = new FakeWebContents(28);
    const tab = adaptWebContents(contents);

    await expect(tab.captureDialogs?.(async () => "done")).resolves.toEqual({
      result: "done",
      dialogs: [],
    });
    contents.debugger.emitMessage("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Unsaved changes?",
    });
    await flushMicrotasks();

    expect(contents.debugger.commands).not.toContainEqual({
      command: "Page.handleJavaScriptDialog",
      params: { accept: false },
    });
  });

  test("treats prompt shim drain failures after navigation as no dialogs", async () => {
    const contents = new FakeWebContents(29);
    contents.debugger.failPromptDrain = true;
    const tab = adaptWebContents(contents);

    await expect(tab.captureDialogs?.(async () => "navigated")).resolves.toEqual({
      result: "navigated",
      dialogs: [],
    });

    expect(contents.debugger.commands).toEqual([
      { command: "Page.enable", params: {} },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
      {
        command: "Runtime.evaluate",
        params: { expression: expect.any(String), returnByValue: true },
      },
      {
        command: "Runtime.evaluate",
        params: {
          expression: expect.stringContaining("delete window[stateKey]"),
          returnByValue: true,
        },
      },
    ]);
  });

  test("runs the command without dialog capture when CDP setup fails", async () => {
    const contents = new FakeWebContents(30);
    contents.debugger.failedCommandNames.add("Page.enable");
    const tab = adaptWebContents(contents);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(tab.captureDialogs?.(async () => "done")).resolves.toEqual({
      result: "done",
      dialogs: [],
    });

    expect(warn).toHaveBeenCalledWith(
      "[browser-automation] Dialog capture unavailable; running command without it",
      { contentsId: 30, error: expect.any(Error) },
    );
    warn.mockRestore();
  });

  test("does not run the command after the debugger target closes during setup", async () => {
    const contents = new FakeWebContents(31);
    contents.debugger.beforeCommand = (command) => {
      if (command === "Page.enable") {
        contents.destroy();
      }
    };
    contents.debugger.failedCommandErrors.set(
      "Page.enable",
      new Error("target closed while handling command"),
    );
    const tab = adaptWebContents(contents);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      tab.captureDialogs?.(() => tab.loadURL("https://replacement.example.com")),
    ).rejects.toThrow("target closed while handling command");
    expect(contents.loadedUrls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  test("runs without dialog capture after a live debugger session detaches", async () => {
    const contents = new FakeWebContents(32);
    const tab = adaptWebContents(contents);

    await expect(tab.captureDialogs?.(async () => "captured")).resolves.toEqual({
      result: "captured",
      dialogs: [],
    });
    contents.debugger.emitDetach();
    contents.debugger.failedCommandNames.add("Page.enable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      tab.captureDialogs?.(() => tab.loadURL("https://replacement.example.com")),
    ).resolves.toEqual({ result: undefined, dialogs: [] });
    expect(contents.loadedUrls).toEqual(["https://replacement.example.com"]);
    expect(contents.debugger.attachedProtocolVersions).toEqual(["1.3"]);
    expect(warn).toHaveBeenCalledWith(
      "[browser-automation] Dialog capture unavailable; running command without it",
      { contentsId: 32, error: expect.any(Error) },
    );

    warn.mockRestore();
  });
});

class FakeHostWebContents {
  private destroyedListener: (() => void) | null = null;

  public constructor(public readonly id: number) {}

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyedListener?.();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("pixel capture frame production", () => {
  test.each([true, false])(
    "restores the prior throttling policy (%s) after capture or failure",
    async (previous) => {
      const contents = new FakeWebContents(8001);
      contents.backgroundThrottling = previous;
      const tab = adaptWebContents(contents);
      expect(
        await tab.withFrameProduction(async () => {
          expect(contents.backgroundThrottling).toBe(false);
          return "pixels";
        }),
      ).toBe("pixels");
      expect(contents.backgroundThrottling).toBe(previous);
      await expect(
        tab.withFrameProduction(async () => {
          throw new Error("capture failed");
        }),
      ).rejects.toThrow("capture failed");
      expect(contents.backgroundThrottling).toBe(previous);
    },
  );

  test("does not touch a guest destroyed during capture", async () => {
    const contents = new FakeWebContents(8002);
    const tab = adaptWebContents(contents);
    await expect(
      tab.withFrameProduction(async () => {
        contents.destroyed = true;
        throw new Error("capture closed");
      }),
    ).rejects.toThrow("capture closed");
  });
});
