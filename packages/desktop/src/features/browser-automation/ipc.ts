import { ipcMain } from "electron";
import { BrowserAutomationExecuteRequestSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type {
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationDialogEvent,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { TabContents, BrowserRegistry, TabImage } from "./service.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { SharedCdpSession, type CdpConsumer, type CdpDebugger } from "./cdp-session-queue.js";
import {
  dialogAcceptValue,
  handledDialogEvent,
  MAX_DIALOGS_PER_COMMAND,
  promptShimDrainScript,
  promptShimInstallScript,
  promptShimRestoreScript,
} from "./dialog-handling.js";
import { BrowserTabClosedError, executeAutomationCommand } from "./service.js";
import { BrowserSnapshotEngine } from "./snapshot-engine.js";
import {
  listRegisteredPaseoBrowserIds,
  listRegisteredPaseoBrowserIdsForWorkspace,
  getPaseoBrowserWebContentsForHostWindow,
  getWorkspaceActivePaseoBrowserIdForHostWindow,
  getPaseoBrowserWorkspaceId,
} from "../browser-webviews/index.js";

const MAX_CONSOLE_MESSAGES_PER_TAB = 200;
const consoleMessagesByContentsId = new Map<number, BrowserAutomationConsoleLogEntry[]>();
const cdpSessionsByContentsId = new Map<number, SharedCdpSession>();
const dialogMonitorsByContentsId = new Map<number, DialogMonitor>();
const observedContentsIds = new Set<number>();

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

interface HostWebContents {
  readonly id: number;
  once(event: "destroyed", listener: () => void): void;
}

export class HostSnapshotEngineRegistry {
  private readonly entries = new Map<
    number,
    { hostContents: HostWebContents; snapshotEngine: BrowserSnapshotEngine }
  >();

  public get(hostContents: HostWebContents): BrowserSnapshotEngine {
    const existing = this.entries.get(hostContents.id);
    if (existing) {
      return existing.snapshotEngine;
    }
    const snapshotEngine = new BrowserSnapshotEngine();
    const entry = { hostContents, snapshotEngine };
    this.entries.set(hostContents.id, entry);
    hostContents.once("destroyed", () => {
      if (this.entries.get(hostContents.id) === entry) {
        this.entries.delete(hostContents.id);
      }
    });
    return snapshotEngine;
  }
}

const hostSnapshotEngines = new HostSnapshotEngineRegistry();

interface ConsoleMessageEmitter {
  on(
    event: "console-message",
    listener: (
      event: unknown,
      level: unknown,
      message: unknown,
      line: unknown,
      sourceId: unknown,
    ) => void,
  ): void;
  once(event: "destroyed", listener: () => void): void;
}

interface BrowserAutomationWebContents extends ConsoleMessageEmitter {
  removeListener(event: "destroyed", listener: () => void): void;
  readonly id: number;
  readonly debugger: CdpDebugger;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  beginFrameSubscription(onlyDirty: boolean, callback: (image: TabImage) => void): void;
  endFrameSubscription(): void;
  invalidate(): void;
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
  sendInputEvent(event: IsolatedKeyboardInputEvent): void;
  insertText(text: string): Promise<void>;
}

export function adaptWebContents(contents: BrowserAutomationWebContents): TabContents {
  const contentsId = contents.id;
  observeConsoleMessages(contents, contentsId);
  const cdpSession = getSharedCdpSession(contents);
  const dialogMonitor = getDialogMonitor(contents, contentsId, cdpSession);
  return {
    id: contentsId,
    getURL: () => contents.getURL(),
    getTitle: () => contents.getTitle(),
    canGoBack: () => contents.canGoBack(),
    canGoForward: () => contents.canGoForward(),
    isLoading: () => contents.isLoading(),
    isDestroyed: () => contents.isDestroyed(),
    executeJavaScript: (code: string) => contents.executeJavaScript(code),
    loadURL: (url: string) => contents.loadURL(url),
    goBack: () => contents.goBack(),
    goForward: () => contents.goForward(),
    reload: () => contents.reload(),
    captureFrame: (signal) => captureViewportFrame(contents, signal),
    invalidate: () => contents.invalidate(),
    withFrameProduction: async (capture) => {
      const previous = contents.getBackgroundThrottling();
      contents.setBackgroundThrottling(false);
      try {
        return await capture();
      } finally {
        if (!contents.isDestroyed()) contents.setBackgroundThrottling(previous);
      }
    },
    sendInputEvent: (event) => contents.sendInputEvent(event),
    insertText: (text) => contents.insertText(text),
    getConsoleMessages: () => consoleMessagesByContentsId.get(contentsId) ?? [],
    captureDialogs: (task) => dialogMonitor.capture(task),
    // Automation sends ordinary commands here; domain and auto-attach toggles
    // belong to a shared CDP consumer so their ownership stays coordinated.
    sendDebugCommand: (command: string, params?: Record<string, unknown>) =>
      cdpSession.sendCommand(command, params),
  };
}

function captureViewportFrame(
  contents: BrowserAutomationWebContents,
  signal: AbortSignal,
): Promise<TabImage> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", abort);
      contents.removeListener("destroyed", destroyed);
      if (!contents.isDestroyed()) contents.endFrameSubscription();
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    const destroyed = () => {
      stop();
      reject(new BrowserTabClosedError());
    };
    signal.addEventListener("abort", abort, { once: true });
    contents.once("destroyed", destroyed);
    try {
      // A resized resident guest can paint while capturePage's surface-copy
      // request remains pending. Subscribe to its rendered frames instead.
      contents.beginFrameSubscription(false, (image) => {
        stop();
        resolve(image);
      });
    } catch (error) {
      stop();
      reject(error);
    }
  });
}

export function getSharedCdpSession(contents: BrowserAutomationWebContents): SharedCdpSession {
  if (contents.isDestroyed()) throw new BrowserTabClosedError();
  const contentsId = contents.id;
  observeConsoleMessages(contents, contentsId);
  const existing = cdpSessionsByContentsId.get(contentsId);
  if (existing) {
    return existing;
  }
  const session = new SharedCdpSession(contents.debugger);
  cdpSessionsByContentsId.set(contentsId, session);
  return session;
}

function observeConsoleMessages(contents: BrowserAutomationWebContents, contentsId: number): void {
  if (observedContentsIds.has(contentsId)) {
    return;
  }
  observedContentsIds.add(contentsId);
  contents.on("console-message", (_event, level, message, line, sourceId) => {
    const entry = normalizeConsoleMessage({ level, message, line, sourceId });
    const messages = consoleMessagesByContentsId.get(contentsId) ?? [];
    messages.push(entry);
    consoleMessagesByContentsId.set(contentsId, messages.slice(-MAX_CONSOLE_MESSAGES_PER_TAB));
  });
  contents.once("destroyed", () => {
    observedContentsIds.delete(contentsId);
    consoleMessagesByContentsId.delete(contentsId);
    cdpSessionsByContentsId.get(contentsId)?.dispose();
    cdpSessionsByContentsId.delete(contentsId);
    dialogMonitorsByContentsId.delete(contentsId);
  });
}

function getDialogMonitor(
  contents: BrowserAutomationWebContents,
  contentsId: number,
  cdpSession: SharedCdpSession,
): DialogMonitor {
  const existing = dialogMonitorsByContentsId.get(contentsId);
  if (existing) {
    return existing;
  }
  const monitor = new DialogMonitor(contents, contentsId, cdpSession);
  dialogMonitorsByContentsId.set(contentsId, monitor);
  return monitor;
}

class DialogMonitor {
  private enabled = false;
  private consumer: CdpConsumer | null = null;
  private detachGeneration = 0;
  private readonly activeCollectors: DialogCollector[] = [];

  public constructor(
    private readonly contents: BrowserAutomationWebContents,
    private readonly contentsId: number,
    private readonly cdpSession: SharedCdpSession,
  ) {}

  public async capture<T>(
    task: () => Promise<T>,
  ): Promise<{ result: T; dialogs: BrowserAutomationDialogEvent[] }> {
    const collector: DialogCollector = { dialogs: [] };
    const setupDetachGeneration = this.detachGeneration;
    try {
      await this.enable();
      await this.installPromptShim();
    } catch (error) {
      if (this.contents.isDestroyed() || this.detachGeneration !== setupDetachGeneration) {
        throw error;
      }
      console.warn("[browser-automation] Dialog capture unavailable; running command without it", {
        contentsId: this.contentsId,
        error,
      });
      return { result: await task(), dialogs: [] };
    }
    this.activeCollectors.push(collector);
    try {
      const result = await task();
      this.recordPromptShimDialogs(await this.drainPromptShim());
      return { result, dialogs: collector.dialogs };
    } finally {
      const index = this.activeCollectors.indexOf(collector);
      if (index >= 0) {
        this.activeCollectors.splice(index, 1);
      }
      if (this.activeCollectors.length === 0) {
        await this.restorePromptShim();
      }
    }
  }

  private async enable(): Promise<void> {
    if (this.enabled) {
      return;
    }
    if (!this.contents.debugger.on) {
      return;
    }
    if (!this.consumer) {
      this.consumer = this.cdpSession.createConsumer({
        onMessage: ({ method, params, sessionId }) => {
          if (sessionId || method !== "Page.javascriptDialogOpening") {
            return;
          }
          if (this.activeCollectors.length === 0) {
            return;
          }
          void this.handleOpening(params);
        },
        onDetach: () => {
          this.enabled = false;
          this.detachGeneration += 1;
        },
      });
    }
    await this.consumer.enableDomain("Page");
    this.enabled = true;
  }

  private async handleOpening(params: Record<string, unknown>): Promise<void> {
    const event = handledDialogEvent(params);
    for (const collector of this.activeCollectors) {
      this.recordDialogs(collector, [event]);
    }
    await this.sendDialogResponseCommand("Page.handleJavaScriptDialog", {
      accept: dialogAcceptValue(event.type),
    });
  }

  private async installPromptShim(): Promise<void> {
    await this.sendDebugCommand("Runtime.evaluate", {
      expression: promptShimInstallScript(),
      returnByValue: true,
    });
  }

  private async drainPromptShim(): Promise<BrowserAutomationDialogEvent[]> {
    try {
      const result = (await this.sendDebugCommand("Runtime.evaluate", {
        expression: promptShimDrainScript(),
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      return parsePromptShimDialogs(result.result?.value);
    } catch {
      return [];
    }
  }

  private async restorePromptShim(): Promise<void> {
    try {
      await this.sendDebugCommand("Runtime.evaluate", {
        expression: promptShimRestoreScript(),
        returnByValue: true,
      });
    } catch {
      // Navigation can destroy the execution context before cleanup runs; the next page has no shim.
    }
  }

  private recordDialogs(collector: DialogCollector, dialogs: BrowserAutomationDialogEvent[]): void {
    for (const dialog of dialogs) {
      if (collector.dialogs.length >= MAX_DIALOGS_PER_COMMAND) {
        return;
      }
      collector.dialogs.push(dialog);
    }
  }

  private recordPromptShimDialogs(dialogs: BrowserAutomationDialogEvent[]): void {
    for (const collector of this.activeCollectors) {
      this.recordDialogs(collector, dialogs);
    }
  }

  private async sendDebugCommand(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.cdpSession.sendCommand(command, params);
  }

  private async sendDialogResponseCommand(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    // Dialogs can block the CDP command that opened them, so the unblocker must not wait behind
    // the per-tab command queue.
    return this.cdpSession.sendImmediate(command, params);
  }
}

interface DialogCollector {
  dialogs: BrowserAutomationDialogEvent[];
}

function parsePromptShimDialogs(value: unknown): BrowserAutomationDialogEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): BrowserAutomationDialogEvent[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (record.type !== "prompt" || record.action !== "dismissed") {
      return [];
    }
    return [
      {
        type: "prompt",
        message: typeof record.message === "string" ? record.message : "",
        ...(typeof record.defaultValue === "string" ? { defaultValue: record.defaultValue } : {}),
        action: "dismissed",
        timestamp: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
      },
    ];
  });
}

function normalizeConsoleMessage(input: {
  level: unknown;
  message: unknown;
  line: unknown;
  sourceId: unknown;
}): BrowserAutomationConsoleLogEntry {
  return {
    level: typeof input.level === "string" ? input.level : String(input.level ?? "log"),
    message: typeof input.message === "string" ? input.message : String(input.message ?? ""),
    ...(typeof input.sourceId === "string" && input.sourceId.length > 0
      ? { source: input.sourceId }
      : {}),
    ...(typeof input.line === "number" ? { line: input.line } : {}),
    timestamp: Date.now(),
  };
}

function createRegistry(hostWebContentsId: number): BrowserRegistry {
  return {
    listRegisteredBrowserIds: listRegisteredPaseoBrowserIds,
    listRegisteredBrowserIdsForWorkspace: listRegisteredPaseoBrowserIdsForWorkspace,
    getTabContents(browserId: string): TabContents | null {
      const contents = getPaseoBrowserWebContentsForHostWindow(browserId, hostWebContentsId);
      return contents ? adaptWebContents(contents) : null;
    },
    getBrowserWorkspaceId: getPaseoBrowserWorkspaceId,
    getWorkspaceActiveBrowserId(workspaceId: string): string | null {
      return getWorkspaceActivePaseoBrowserIdForHostWindow(workspaceId, hostWebContentsId);
    },
  };
}

export function registerBrowserAutomationIpc(options?: { ipc?: IpcHandlerRegistry }): void {
  const ipc = options?.ipc ?? ipcMain;

  ipc.handle("paseo:browser:execute-automation-command", async (event, rawRequest: unknown) => {
    const hostContents = (event as { sender?: HostWebContents }).sender;
    const hostWebContentsId = hostContents?.id;
    if (!hostContents || typeof hostWebContentsId !== "number") {
      return {
        requestId: readRequestId(rawRequest),
        ok: false as const,
        error: {
          code: "browser_unsupported" as const,
          message: "Browser automation requires a host window.",
        },
      };
    }
    const registry = createRegistry(hostWebContentsId);
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      return {
        requestId: readRequestId(rawRequest),
        ok: false as const,
        error: {
          code: "browser_unsupported" as const,
          message: `Invalid automation request: ${parsed.error.message}`,
          retryable: false,
        },
      };
    }
    return executeAutomationCommand(parsed.data, registry, {
      snapshotEngine: hostSnapshotEngines.get(hostContents),
    });
  });
}

function readRequestId(rawRequest: unknown): string {
  if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
    return "unknown";
  }
  const requestId = (rawRequest as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : "unknown";
}
