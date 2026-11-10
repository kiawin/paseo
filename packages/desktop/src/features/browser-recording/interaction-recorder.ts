import {
  ipcMain,
  webContents,
  type IpcMain,
  type IpcMainEvent,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { getSharedCdpSession } from "../browser-automation/ipc.js";
import type { CdpConsumer } from "../browser-automation/cdp-session-queue.js";
import type { BrowserRecordingCoordinator, RecordingMembership } from "./coordinator.js";

const STATE = "paseo:browser-recording-state";
const HELLO = "paseo:browser-recording-document";
const CLICK = "paseo:browser-recording-click";
const MARKER =
  "typeof globalThis.__paseoRecordingNonce === 'string' ? globalThis.__paseoRecordingNonce : null";
const NONCE = /^[0-9a-f]{32}$/;
const MAX_DOCUMENTS = 512;
const MAX_CONTEXTS = 1024;

type RecordValue = Record<string, unknown>;
interface DocumentInfo {
  contentsId: number;
  sourceKey: string;
  nonce: string;
  verified?: boolean;
  frameId?: string;
  documentId?: string;
}
interface ContextInfo {
  contents: WebContents;
  contextId: number;
  frameId: string;
  sessionId?: string;
  documentId?: string;
  nonce?: string;
  resolving: boolean;
  requested: boolean;
}
interface Options {
  coordinator: BrowserRecordingCoordinator;
  ipc?: IpcMain;
  onError: (error: unknown) => void;
}
const obj = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const nonceOf = (value: unknown): string | null =>
  typeof value === "string" && NONCE.test(value) ? value : null;
const validModifiers = (value: RecordValue): boolean =>
  ["alt", "control", "meta", "shift"].every((name) => typeof value[name] === "boolean");
const ELEMENT_NAMES = ["tag", "id", "name", "role", "label", "href"] as const;
const ELEMENT_LIMITS = [64, 256, 256, 128, 256, 2048];
function validInteraction(raw: RecordValue, element: RecordValue, modifiers: RecordValue): boolean {
  return (
    typeof raw.at === "number" &&
    Number.isFinite(raw.at) &&
    typeof element.truncated === "boolean" &&
    (raw.button === "primary" || raw.button === "middle") &&
    validModifiers(modifiers) &&
    (raw.activation === "pointer" || raw.activation === "keyboard-or-assistive") &&
    ELEMENT_NAMES.every(
      (name, index) =>
        typeof element[name] === "string" &&
        (element[name] as string).length <= ELEMENT_LIMITS[index],
    )
  );
}
const keyOf = (contentsId: number, nonce: string) => `${contentsId}:${nonce}`;
function findFrameLoader(value: unknown, frameId: string): string | null {
  const pending: unknown[] = [value];
  for (let count = 0; pending.length && count < MAX_CONTEXTS; count += 1) {
    const node = obj(pending.pop());
    const frame = obj(node.frame);
    if (frame.id === frameId && typeof frame.loaderId === "string" && frame.loaderId)
      return frame.loaderId;
    if (Array.isArray(node.childFrames)) {
      for (const child of node.childFrames) {
        if (pending.length >= MAX_CONTEXTS) break;
        pending.push(child);
      }
    }
  }
  return null;
}

// Include trusted pointer and keyboard activations, including CDP input whose
// human/automation origin cannot be proven. Exclude page-scripted events.
export function createInteractionRecorder(options: Options) {
  const ipc = options.ipc ?? ipcMain;
  const coordinator = options.coordinator;
  const documents = new Map<string, DocumentInfo>();
  const contexts = new Map<string, ContextInfo>();
  const consumers = new Map<number, CdpConsumer>();
  const rates = new Map<string, { tokens: number; at: number }>();
  const frameChecks = new Map<
    string,
    {
      contentsId: number;
      frameId: string;
      documentId: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let resolvingCount = 0;
  let registered = false;
  let disposed = false;
  const report = (member: RecordingMembership, reason: string) => {
    void coordinator
      .reportGap({ recordingId: member.recordingId, memberId: member.memberId, reason })
      .catch(options.onError);
  };
  const validSender = (
    event: IpcMainEvent,
  ): {
    contents: WebContents;
    frame: WebFrameMain;
    member: RecordingMembership;
    sourceKey: string;
  } | null => {
    const contents = event.sender;
    const frame = event.senderFrame;
    const member = coordinator.getMembership(contents.id);
    if (!member || !frame || frame.detached || contents.isDestroyed()) return null;
    try {
      if (
        !contents.mainFrame.framesInSubtree.some(
          (candidate) =>
            candidate.processId === frame.processId && candidate.frameToken === frame.frameToken,
        )
      )
        return null;
      return {
        contents,
        frame,
        member,
        sourceKey: `${contents.id}:${frame.processId}:${frame.frameToken}`,
      };
    } catch {
      return null;
    }
  };
  const broadcast = (contents: WebContents, enabled: boolean): void => {
    if (contents.isDestroyed()) return;
    try {
      for (const frame of contents.mainFrame.framesInSubtree)
        if (!frame.detached) frame.send(STATE, enabled);
    } catch (error) {
      options.onError(error);
    }
  };
  const cleanupContents = (id: number): void => {
    for (const [key, doc] of documents) if (doc.contentsId === id) documents.delete(key);
    for (const [key, context] of contexts) if (context.contents.id === id) contexts.delete(key);
    for (const key of rates.keys()) if (key.startsWith(`${id}:`)) rates.delete(key);
    for (const [key, check] of frameChecks)
      if (check.contentsId === id) {
        clearTimeout(check.timer);
        frameChecks.delete(key);
      }
    const consumer = consumers.get(id);
    if (consumer) {
      consumers.delete(id);
      void consumer.release().catch(options.onError);
    }
  };
  const unsubscribeBeforeRemoval = coordinator.subscribeBeforeRemoval((member) => {
    for (const [key, check] of frameChecks) {
      if (check.contentsId !== member.webContentsId) continue;
      clearTimeout(check.timer);
      frameChecks.delete(key);
      report(member, "interaction-frame-instrumentation-unavailable");
    }
  });
  const unsubscribe = coordinator.subscribe((change) => {
    if (change.type === "removed" || change.type === "replaced") {
      const oldId =
        "previousWebContentsId" in change
          ? change.previousWebContentsId
          : change.member.webContentsId;
      const oldContents = webContents.fromId(oldId);
      if (oldContents) broadcast(oldContents, false);
      cleanupContents(oldId);
    }
    if (change.type === "removed") return;
    const contents = webContents.fromId(change.member.webContentsId);
    if (contents) {
      broadcast(contents, true);
    }
  });

  const reconcile = (contentsId: number): void => {
    for (const context of contexts.values()) {
      if (context.contents.id !== contentsId || !context.nonce) continue;
      const document = documents.get(keyOf(contentsId, context.nonce));
      if (!document) continue;
      document.verified = true;
      const frame = coordinator.getFrame({ webContentsId: contentsId, frameId: context.frameId });
      const documentId = context.documentId;
      if (documentId && frame?.documentId === documentId) {
        document.frameId = context.frameId;
        document.documentId = documentId;
        const key = JSON.stringify([contentsId, context.frameId]);
        const check = frameChecks.get(key);
        if (check?.documentId === documentId) {
          clearTimeout(check.timer);
          frameChecks.delete(key);
        }
      }
    }
  };
  // Limit queued CDP work so a page with many frames cannot monopolize automation.
  const pumpContexts = (): void => {
    if (disposed) return;
    for (const [key, context] of contexts) {
      if (resolvingCount >= 8) return;
      if (!context.requested || context.resolving || context.contents.isDestroyed()) continue;
      context.requested = false;
      context.resolving = true;
      let consumer = consumers.get(context.contents.id);
      if (!consumer) {
        try {
          consumer = getSharedCdpSession(context.contents).createConsumer({});
          consumers.set(context.contents.id, consumer);
        } catch (error) {
          context.resolving = false;
          options.onError(error);
          continue;
        }
      }
      resolvingCount += 1;
      const activeConsumer = consumer;
      const evaluate = () =>
        activeConsumer.sendCommand(
          "Runtime.evaluate",
          { expression: MARKER, contextId: context.contextId, returnByValue: true },
          context.sessionId,
        );
      void (async () => {
        const first = nonceOf(obj(obj(await evaluate()).result).value);
        if (!first || contexts.get(key) !== context || disposed) return;
        const tree = obj(
          await activeConsumer.sendCommand("Page.getFrameTree", {}, context.sessionId),
        );
        const loaderId = findFrameLoader(tree.frameTree, context.frameId);
        if (!loaderId) return;
        const second = nonceOf(obj(obj(await evaluate()).result).value);
        if (first !== second || contexts.get(key) !== context || disposed) return;
        context.nonce = first;
        context.documentId = loaderId;
        reconcile(context.contents.id);
      })()
        .catch(() => {})
        .finally(() => {
          context.resolving = false;
          resolvingCount -= 1;
          pumpContexts();
        });
    }
  };
  const resolveContext = (_key: string, context: ContextInfo, force = false): void => {
    if ((context.nonce && !force) || disposed) return;
    context.requested = true;
    pumpContexts();
  };
  const respondState = (event: IpcMainEvent, enabled: boolean): void => {
    if (!event.senderFrame || event.senderFrame.detached) return;
    try {
      event.senderFrame.send(STATE, enabled);
    } catch {
      /* frame may have navigated */
    }
  };
  const evictDocument = (): void => {
    const entries = Array.from(documents.entries());
    const stale = entries.find(
      ([, document]) =>
        document.verified &&
        document.frameId &&
        document.documentId &&
        coordinator.getFrame({ webContentsId: document.contentsId, frameId: document.frameId })
          ?.documentId !== document.documentId,
    );
    const candidate = stale ?? entries.find(([, document]) => !document.verified) ?? entries[0];
    if (candidate) {
      const [oldestKey, oldest] = candidate;
      const member = coordinator.getMembership(oldest.contentsId);
      if (!stale && member) report(member, "interaction-document-limit");
      documents.delete(oldestKey);
    }
  };
  const hello = (event: IpcMainEvent, payload: unknown): void => {
    const raw = obj(payload);
    const nonce = nonceOf(raw.nonce);
    const source = validSender(event);
    if (source && raw.unavailable === true)
      report(source.member, "interaction-preload-unavailable");
    if (raw.requestState === true) respondState(event, Boolean(source && raw.unavailable !== true));
    if (!source || !nonce) return;
    const key = keyOf(source.contents.id, nonce);
    const existing = documents.get(key);
    if (existing && existing.sourceKey !== source.sourceKey) {
      report(source.member, "interaction-frame-identity-conflict");
      return;
    }
    if (!existing && documents.size >= MAX_DOCUMENTS) evictDocument();
    documents.set(
      key,
      existing ?? { contentsId: source.contents.id, sourceKey: source.sourceKey, nonce },
    );
    try {
      const cached = getSharedCdpSession(source.contents).runtimeContextSnapshot();
      if (cached.dropped) report(source.member, "interaction-context-cache-overflow");
      for (const message of cached.contexts)
        onCdpEvent(source.contents, message.method, message.params, message.sessionId);
    } catch (error) {
      report(source.member, "interaction-context-cache-unavailable");
      options.onError(error);
    }
    for (const [contextKey, context] of contexts)
      if (context.contents.id === source.contents.id) resolveContext(contextKey, context);
    reconcile(source.contents.id);
  };
  const allowClick = (sourceKey: string, member: RecordingMembership): boolean => {
    const now = Date.now();
    let rate = rates.get(sourceKey);
    if (!rate) {
      if (rates.size >= MAX_DOCUMENTS) {
        report(member, "interaction-rate-source-limit");
        return false;
      }
      rate = { tokens: 120, at: now };
      rates.set(sourceKey, rate);
    }
    rate.tokens = Math.min(120, rate.tokens + Math.max(0, now - rate.at) * 0.06);
    rate.at = now;
    if (rate.tokens < 1) {
      report(member, "interaction-rate-limit");
      return false;
    }
    rate.tokens -= 1;
    return true;
  };
  const click = (event: IpcMainEvent, payload: unknown): void => {
    const source = validSender(event);
    if (!source) return;
    const raw = obj(payload);
    const nonce = nonceOf(raw.nonce);
    const element = obj(raw.element);
    const modifiers = obj(raw.modifiers);
    if (!nonce || !validInteraction(raw, element, modifiers)) return;
    const interaction = {
      at: raw.at,
      receivedAt: Date.now(),
      activation: raw.activation,
      button: raw.button,
      modifiers: {
        alt: modifiers.alt,
        control: modifiers.control,
        meta: modifiers.meta,
        shift: modifiers.shift,
      },
      origin: "unknown",
      element: {
        ...Object.fromEntries(ELEMENT_NAMES.map((name) => [name, element[name]])),
        truncated: element.truncated,
      },
    };
    const document = documents.get(keyOf(source.contents.id, nonce));
    if (!document) {
      report(source.member, "interaction-document-unverified");
      // Reject the unverified nonce and ask the isolated preload to announce
      // this document again after a bounded-map eviction.
      try {
        source.frame.send(STATE, true);
      } catch {
        /* frame navigated */
      }
      return;
    }
    if (document.sourceKey !== source.sourceKey) {
      report(source.member, "interaction-frame-identity-conflict");
      return;
    }
    if (!document.verified) {
      report(source.member, "interaction-document-unverified");
      return;
    }
    if (!allowClick(source.sourceKey, source.member)) return;
    const frame =
      document.frameId && document.documentId
        ? { frameId: document.frameId, documentId: document.documentId }
        : {};
    if (!document.frameId || !document.documentId)
      report(source.member, "interaction-frame-unattributed");
    // If navigation has already advanced this frame, the coordinator reports
    // a stale-document gap instead of assigning the old click to the new page.
    void coordinator
      .emit({
        webContentsId: source.contents.id,
        ...frame,
        kind: "interaction",
        payload: interaction,
      })
      .catch(options.onError);
  };
  function registerContext(contents: WebContents, params: RecordValue, sessionId?: string): void {
    const context = obj(params.context);
    const aux = obj(context.auxData);
    if (
      context.name !== "Electron Isolated Context" ||
      typeof context.id !== "number" ||
      typeof aux.frameId !== "string"
    )
      return;
    const key = JSON.stringify([contents.id, sessionId ?? null, context.id]);
    const prior = contexts.get(key);
    if (prior && prior.frameId === aux.frameId) return;
    if (!contexts.has(key) && contexts.size >= MAX_CONTEXTS) {
      const member = coordinator.getMembership(contents.id);
      if (member) report(member, "interaction-context-limit");
      const oldest = contexts.keys().next().value;
      if (oldest) contexts.delete(oldest);
    }
    const entry: ContextInfo = {
      contents,
      contextId: context.id,
      frameId: aux.frameId,
      sessionId,
      resolving: false,
      requested: false,
    };
    contexts.set(key, entry);
    resolveContext(key, entry);
  }
  function removeContexts(contentsId: number, sessionId: unknown): void {
    for (const [key, context] of contexts) {
      if (context.contents.id === contentsId && context.sessionId === sessionId) {
        contexts.delete(key);
      }
    }
  }
  function checkFrame(contents: WebContents, frameId: string, documentId: string): void {
    if (
      Array.from(documents.values()).some(
        (document) =>
          document.contentsId === contents.id &&
          document.verified &&
          document.frameId === frameId &&
          document.documentId === documentId,
      )
    )
      return;
    const key = JSON.stringify([contents.id, frameId]);
    const prior = frameChecks.get(key);
    if (prior?.documentId === documentId) return;
    if (prior) {
      clearTimeout(prior.timer);
    }
    if (!prior && frameChecks.size >= MAX_CONTEXTS) {
      const member = coordinator.getMembership(contents.id);
      if (member) report(member, "interaction-frame-check-limit");
      return;
    }
    const timer = setTimeout(() => {
      frameChecks.delete(key);
      const member = coordinator.getMembership(contents.id);
      if (
        member &&
        coordinator.getFrame({ webContentsId: contents.id, frameId })?.documentId === documentId
      )
        report(member, "interaction-frame-instrumentation-unavailable");
    }, 2000);
    timer.unref();
    frameChecks.set(key, { contentsId: contents.id, frameId, documentId, timer });
  }
  function handleFrameEvent(contents: WebContents, method: string, params: RecordValue): void {
    if (method === "Page.frameDetached") {
      if (typeof params.frameId !== "string") return;
      const key = JSON.stringify([contents.id, params.frameId]);
      const check = frameChecks.get(key);
      if (check) {
        clearTimeout(check.timer);
        frameChecks.delete(key);
        const member = coordinator.getMembership(contents.id);
        if (member) report(member, "interaction-frame-instrumentation-unavailable");
      }
      return;
    }
    const frame = obj(params.frame);
    if (typeof frame.id === "string" && typeof frame.loaderId === "string") {
      checkFrame(contents, frame.id, frame.loaderId);
      for (const [key, context] of contexts) {
        if (
          context.contents.id === contents.id &&
          context.frameId === frame.id &&
          context.documentId !== frame.loaderId
        )
          resolveContext(key, context, true);
      }
    }
    reconcile(contents.id);
  }
  function onCdpEvent(
    contents: WebContents,
    method: string,
    params: RecordValue,
    sessionId?: string,
  ): void {
    if (disposed || !coordinator.getMembership(contents.id)) return;
    if (method === "Runtime.executionContextCreated") registerContext(contents, params, sessionId);
    else if (
      method === "Runtime.executionContextDestroyed" &&
      typeof params.executionContextId === "number"
    ) {
      const key = JSON.stringify([contents.id, sessionId ?? null, params.executionContextId]);
      contexts.delete(key);
    } else if (
      method === "Runtime.executionContextsCleared" ||
      method === "Target.detachedFromTarget"
    ) {
      if (method === "Target.detachedFromTarget" && typeof params.sessionId !== "string") return;
      removeContexts(
        contents.id,
        method === "Target.detachedFromTarget" ? params.sessionId : sessionId,
      );
    } else if (
      ["Page.frameNavigated", "Page.frameSnapshot", "Page.frameDetached"].includes(method)
    ) {
      handleFrameEvent(contents, method, params);
    }
  }
  return {
    onCdpEvent,
    registerIpc() {
      if (registered) return;
      registered = true;
      ipc.on(HELLO, hello);
      ipc.on(CLICK, click);
    },
    getFrameCount(contentsId: number) {
      return Array.from(documents.values()).filter(
        (doc) =>
          doc.contentsId === contentsId &&
          doc.frameId &&
          doc.documentId &&
          coordinator.getFrame({ webContentsId: contentsId, frameId: doc.frameId })?.documentId ===
            doc.documentId,
      ).length;
    },
    getFrameDocuments(contentsId: number) {
      return Array.from(documents.values()).flatMap((doc) => {
        if (doc.contentsId !== contentsId || !doc.frameId || !doc.documentId) return [];
        if (
          coordinator.getFrame({ webContentsId: contentsId, frameId: doc.frameId })?.documentId !==
          doc.documentId
        )
          return [];
        return [{ frameId: doc.frameId, documentId: doc.documentId }];
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeBeforeRemoval();
      unsubscribe();
      if (registered) {
        ipc.removeListener(HELLO, hello);
        ipc.removeListener(CLICK, click);
      }
      for (const id of consumers.keys()) cleanupContents(id);
      documents.clear();
      contexts.clear();
      rates.clear();
      for (const check of frameChecks.values()) clearTimeout(check.timer);
      frameChecks.clear();
    },
  };
}
