import { BrowserWindow, webContents, type WebContents } from "electron";
import { getSharedCdpSession } from "../browser-automation/ipc.js";
import type { CdpConsumer } from "../browser-automation/cdp-session-queue.js";
import { decideBrowserWindowOpenRequest } from "../browser-webviews/window-open.js";
import type { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserRecordingCoordinator, type RecordingMembership } from "./coordinator.js";
import { RequestBodyPolicy } from "./request-body-policy.js";

interface LifecycleOptions {
  registry: PaseoBrowserWebviewRegistry;
  onTabOpen: (input: {
    sourceContents: WebContents;
    mainWindow: BrowserWindow;
    url: string;
    browserId?: string;
    sourceBrowserId?: string;
  }) => void;
  onPopup: (popup: BrowserWindow) => void;
  onError: (error: unknown) => void;
  onCaptureFailure?: (recordingId: string, error: unknown) => void;
  onCdpEvent?: (
    contents: WebContents,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => void;
  popupOptions?: (mainWindow: BrowserWindow) => Electron.BrowserWindowConstructorOptions;
  tabReservationTtlMs?: number;
}

export function createBrowserRecordingLifecycle(options: LifecycleOptions) {
  const networkLimits = {
    maxTotalBufferSize: 4 * 1024 * 1024,
    maxResourceBufferSize: 512 * 1024,
    maxPostDataSize: 256 * 1024,
  };
  // The one-use proof is minted in Electron's createWindow callback, where
  // Chromium has just supplied the child for this particular opener.
  const proof = new Map<number, number>();
  const earlyPopups = new Set<number>();
  const pending = new Map<
    string,
    { token: string; parent: RecordingMembership; timer: ReturnType<typeof setTimeout> }
  >();
  const consumers = new Map<
    number,
    { consumer: CdpConsumer; contents: WebContents; bodyPolicy: RequestBodyPolicy }
  >();
  const readiness = new Map<number, Promise<void>>();
  const reservationTtlMs = options.tabReservationTtlMs ?? 30_000;
  const coordinator = new BrowserRecordingCoordinator(
    options.registry,
    (opener, popup) => {
      const matches = proof.get(popup) === opener;
      proof.delete(popup);
      return matches;
    },
    { pendingTabTtlMs: reservationTtlMs },
  );
  const gap = (member: RecordingMembership, reason: string) => {
    const members = coordinator.listMemberships(member.recordingId);
    const live =
      members.find((candidate) => candidate.memberId === member.memberId) ??
      members.find((candidate) => candidate.parentMemberId === null);
    if (!live) return;
    void coordinator
      .reportGap({ recordingId: live.recordingId, memberId: live.memberId, reason })
      .catch(options.onError);
  };
  function release(id: number): void {
    const entry = consumers.get(id);
    if (!entry) return;
    consumers.delete(id);
    readiness.delete(id);
    void entry.consumer.release().catch((error) => {
      if (!entry.contents.isDestroyed()) options.onError(error);
    });
  }
  function instrument(contents: WebContents, member: RecordingMembership, early: boolean): void {
    if (consumers.has(contents.id)) return;
    const shared = getSharedCdpSession(contents);
    const bodyPolicy = new RequestBodyPolicy();
    const frameVersions = new Map<string, number>();
    let detachGeneration = 0;
    const snapshot = async (consumer: CdpConsumer, sessionId?: string): Promise<void> => {
      const before = new Map(frameVersions);
      const generation = detachGeneration;
      const result = (await consumer.sendCommand("Page.getFrameTree", {}, sessionId)) as {
        frameTree?: unknown;
      };
      if (generation !== detachGeneration || consumers.get(contents.id)?.consumer !== consumer)
        return;
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const tree = value as { frame?: Record<string, unknown>; childFrames?: unknown[] };
        const frame = tree.frame;
        if (
          frame &&
          typeof frame.id === "string" &&
          typeof frame.loaderId === "string" &&
          frame.loaderId &&
          (before.get(frame.id) ?? 0) === (frameVersions.get(frame.id) ?? 0)
        ) {
          coordinator.registerFrame({
            webContentsId: contents.id,
            frameId: frame.id,
            documentId: frame.loaderId,
          });
          options.onCdpEvent?.(contents, "Page.frameSnapshot", { frame }, sessionId);
        }
        tree.childFrames?.forEach(visit);
      };
      visit(result.frameTree);
    };
    const enableRuntime = (sessionId?: string): Promise<void> =>
      consumer.enableDomain("Runtime", sessionId).catch((error) => {
        if (!contents.isDestroyed() && coordinator.getMembership(contents.id)) {
          gap(member, "interaction-runtime-unavailable");
          options.onError(error);
        }
      });
    const consumer = shared.createConsumer({
      onMessage: ({ method, params, sessionId }) => {
        bodyPolicy.observe(method, params, sessionId);
        if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
          const childSession = params.sessionId;
          const info = params.targetInfo as { type?: unknown } | undefined;
          if (info?.type !== "iframe" && info?.type !== "page") {
            gap(member, "unsupported-child-target");
            options.onCdpEvent?.(contents, method, params, sessionId);
            return;
          }
          void Promise.all([
            consumer.enableDomain("Network", childSession, networkLimits),
            consumer.enableDomain("Page", childSession),
            enableRuntime(childSession),
            consumer.enableAutoAttach(childSession),
          ])
            .then(async () => {
              await snapshot(consumer, childSession);
              gap(member, "child-target-attached-after-navigation");
              return undefined;
            })
            .catch((error) => {
              if (!contents.isDestroyed() && coordinator.getMembership(contents.id)) {
                gap(member, "child-target-setup-failed");
                options.onError(error);
              }
            });
        }
        if (method === "Page.frameNavigated" && params.frame && typeof params.frame === "object") {
          const frame = params.frame as Record<string, unknown>;
          if (
            typeof frame.id === "string" &&
            typeof frame.loaderId === "string" &&
            frame.loaderId
          ) {
            frameVersions.set(frame.id, (frameVersions.get(frame.id) ?? 0) + 1);
            coordinator.registerFrame({
              webContentsId: contents.id,
              frameId: frame.id,
              documentId: frame.loaderId,
            });
          }
        }
        if (method === "Page.frameDetached" && typeof params.frameId === "string") {
          // Deliver detach while its last document identity is still available.
          options.onCdpEvent?.(contents, method, params, sessionId);
          frameVersions.set(params.frameId, (frameVersions.get(params.frameId) ?? 0) + 1);
          coordinator.removeFrame({ webContentsId: contents.id, frameId: params.frameId });
          return;
        }
        options.onCdpEvent?.(contents, method, params, sessionId);
      },
      onDetach: () => {
        if (consumers.get(contents.id)?.consumer !== consumer) return;
        const generation = ++detachGeneration;
        coordinator.clearFrames(contents.id);
        frameVersions.clear();
        options.onCdpEvent?.(contents, "Paseo.debuggerDetached", {});
        gap(member, "debugger-detached");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Debugger recovery timed out")), 8000);
        });
        void Promise.race([consumer.recover().then(() => snapshot(consumer)), timeout]).then(
          () => {
            if (timer) clearTimeout(timer);
            if (
              generation === detachGeneration &&
              consumers.get(contents.id)?.consumer === consumer
            )
              gap(member, "debugger-recovered");
            return undefined;
          },
          (error: unknown) => {
            if (timer) clearTimeout(timer);
            if (
              generation !== detachGeneration ||
              consumers.get(contents.id)?.consumer !== consumer
            )
              return;
            gap(member, "debugger-recovery-failed");
            options.onError(error);
            options.onCaptureFailure?.(member.recordingId, error);
          },
        );
      },
    });
    consumers.set(contents.id, { consumer, contents, bodyPolicy });
    let network: Promise<void>;
    try {
      network = early
        ? shared.primeDomain(consumer, "Network", networkLimits)
        : consumer.enableDomain("Network", undefined, networkLimits);
      if (!early) gap(member, "capture-setup-pending");
    } catch (error) {
      release(contents.id);
      throw error;
    }
    const ready = network
      .then(() =>
        Promise.all([consumer.enableDomain("Page"), enableRuntime(), consumer.enableAutoAttach()]),
      )
      .then(async () => {
        await snapshot(consumer);
        return undefined;
      });
    readiness.set(contents.id, ready);
    void ready.catch((error) => {
      if (consumers.get(contents.id)?.consumer === consumer) release(contents.id);
      if (!contents.isDestroyed() && coordinator.getMembership(contents.id)) {
        gap(member, "capture-setup-failed");
        options.onError(error);
      }
    });
  }
  coordinator.subscribe((change) => {
    if (change.type === "removed" || change.type === "replaced") {
      release(
        "previousWebContentsId" in change
          ? change.previousWebContentsId
          : change.member.webContentsId,
      );
      if (change.type === "removed" && change.member.parentMemberId === null)
        for (const [id, reservation] of pending) {
          if (reservation.parent.recordingId === change.member.recordingId) {
            clearTimeout(reservation.timer);
            pending.delete(id);
          }
        }
    }
    if (change.type === "removed" || earlyPopups.has(change.member.webContentsId)) return;
    const contents = webContents.fromId(change.member.webContentsId);
    if (!contents || contents.isDestroyed()) {
      gap(change.member, "guest-unavailable");
      return;
    }
    try {
      instrument(contents, change.member, false);
    } catch (error) {
      gap(change.member, "capture-setup-failed");
      options.onError(error);
    }
  });

  function installWindowOpenHandler(input: {
    contents: WebContents;
    sourceContents: WebContents;
    mainWindow: BrowserWindow;
  }): void {
    const { contents, sourceContents, mainWindow } = input;
    function setupPopup(popup: BrowserWindow): void {
      options.onPopup(popup);
      installWindowOpenHandler({ contents: popup.webContents, sourceContents, mainWindow });
    }
    contents.setWindowOpenHandler(({ url, disposition, frameName, features, postBody }) => {
      const decision = decideBrowserWindowOpenRequest({
        url,
        disposition,
        frameName,
        features,
        hasPostBody: postBody != null,
      });
      if (decision.kind === "deny") return { action: "deny" };
      const parent = coordinator.getMembership(contents.id);
      if (decision.kind === "popup") {
        const overrideBrowserWindowOptions = options.popupOptions?.(mainWindow) ?? {};
        if (!parent) return { action: "allow", overrideBrowserWindowOptions };
        return {
          action: "allow",
          overrideBrowserWindowOptions,
          createWindow(windowOptions) {
            const popup = new BrowserWindow(windowOptions);
            const child = popup.webContents;
            proof.set(child.id, contents.id);
            earlyPopups.add(child.id);
            try {
              const member = coordinator.addPopupFromOpen({
                openerWebContentsId: contents.id,
                popupWebContentsId: child.id,
              });
              child.once("destroyed", () => {
                void coordinator.removeMember(child.id, "closed").catch(options.onError);
              });
              instrument(child, member, true);
            } catch (error) {
              proof.delete(child.id);
              release(child.id);
              void coordinator.removeMember(child.id, "closed").catch(options.onError);
              gap(parent, "popup-admission-failed");
              options.onError(error);
            } finally {
              earlyPopups.delete(child.id);
            }
            try {
              setupPopup(popup);
            } catch (error) {
              gap(parent, "popup-setup-failed");
              options.onError(error);
            }
            return child;
          },
        };
      }
      let browserId: string | undefined;
      if (parent) {
        try {
          const reservation = coordinator.reserveTabOpen(contents.id);
          browserId = reservation.browserId;
          const timer = setTimeout(() => {
            pending.delete(reservation.browserId);
            gap(parent, "tab-claim-expired");
          }, reservationTtlMs);
          timer.unref();
          pending.set(browserId, { token: reservation.token, parent, timer });
        } catch (error) {
          gap(parent, "tab-reservation-failed");
          options.onError(error);
        }
      }
      let sourceBrowserId: string | undefined;
      if (parent) {
        const members = coordinator.listMemberships(parent.recordingId);
        let ancestor: RecordingMembership | undefined = parent;
        while (ancestor && !ancestor.browserId)
          ancestor = members.find((member) => member.memberId === ancestor?.parentMemberId);
        sourceBrowserId = ancestor?.browserId ?? undefined;
      }
      try {
        options.onTabOpen({
          sourceContents,
          mainWindow,
          url: decision.url,
          browserId,
          sourceBrowserId,
        });
      } catch (error) {
        if (browserId) {
          const reservation = pending.get(browserId);
          if (reservation) {
            clearTimeout(reservation.timer);
            pending.delete(browserId);
            gap(reservation.parent, "tab-open-delivery-failed");
          }
        }
        options.onError(error);
      }
      return { action: "deny" };
    });
    contents.on("did-create-window", (popup) => setupPopup(popup));
  }
  function attached(hostWebContentsId: number, browserId: string): void {
    const reservation = pending.get(browserId);
    if (reservation) {
      // Leave a wrong-host reservation for its owner or its expiry gap.
      if (hostWebContentsId !== reservation.parent.hostWebContentsId) return;
      pending.delete(browserId);
      clearTimeout(reservation.timer);
      try {
        const member = coordinator.claimTabOpen({
          token: reservation.token,
          hostWebContentsId,
          browserId,
        });
        gap(member, "tab-first-navigation-before-attachment");
      } catch (error) {
        gap(reservation.parent, "tab-claim-failed");
        options.onError(error);
      }
      return;
    }
    const existing = coordinator.getBrowserMembership(hostWebContentsId, browserId);
    if (existing) {
      try {
        coordinator.replaceBrowserGuest({ hostWebContentsId, browserId });
      } catch (error) {
        // The coordinator records the replacement failure on the member.
        options.onError(error);
      }
    }
  }
  return {
    coordinator,
    installWindowOpenHandler,
    attached,
    // The Electron harness waits for setup before asserting later navigation.
    ready: (id: number) =>
      readiness.get(id) ?? Promise.reject(new Error("Guest is not instrumented")),
    backgroundCommand: async (
      id: number,
      command: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => {
      const entry = consumers.get(id);
      if (!entry) throw new Error("Guest is not instrumented");
      if (command === "Network.getRequestPostData") {
        if (typeof params.requestId !== "string") throw new Error("Invalid request identifier");
        await entry.bodyPolicy.assertAllowed(params.requestId, sessionId ?? null);
      }
      return entry.consumer.sendBackgroundCommand(command, params, sessionId);
    },
    retainNetwork: (id: number) => {
      const entry = consumers.get(id);
      if (!entry) throw new Error("Guest is not instrumented");
      const consumer = getSharedCdpSession(entry.contents).createConsumer({});
      const ready = consumer.enableDomain("Network", undefined, networkLimits);
      void ready.catch(() => {});
      const send = async (command: string, requestId: string, sessionId: string | null) => {
        await ready;
        if (command === "Network.getRequestPostData")
          await entry.bodyPolicy.assertAllowed(requestId, sessionId);
        if (sessionId) await consumer.enableDomain("Network", sessionId, networkLimits);
        return consumer.sendBackgroundCommand(command, { requestId }, sessionId ?? undefined);
      };
      return {
        ready,
        getResponseBody: (requestId: string, sessionId: string | null) =>
          send("Network.getResponseBody", requestId, sessionId),
        getRequestPostData: (requestId: string, sessionId: string | null) =>
          send("Network.getRequestPostData", requestId, sessionId),
        async release() {
          await ready.catch(() => {});
          await consumer.release();
        },
      };
    },
  };
}
