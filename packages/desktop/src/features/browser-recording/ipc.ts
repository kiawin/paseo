import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CaptureBudget } from "./capture-budget.js";
import { BodyReadGate } from "./body-read-gate.js";
import { NetworkRecorder, type NetworkTransaction } from "./network-recorder.js";
import type { BrowserRecordingCoordinator, RecordingMembership } from "./coordinator.js";
import type { BrowserRecordingStore } from "./store.js";
import type { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";

interface Caller {
  senderId: number;
  mainFrame: boolean;
  url?: string;
}
interface BodyReader {
  ready?: Promise<void>;
  getResponseBody(
    requestId: string,
    sessionId: string | null,
  ): Promise<{ body: string; base64Encoded: boolean }>;
  getRequestPostData(requestId: string, sessionId: string | null): Promise<{ postData: string }>;
  release(): Promise<void>;
}
interface Options {
  registry: PaseoBrowserWebviewRegistry;
  coordinator: BrowserRecordingCoordinator;
  store: BrowserRecordingStore;
  video: { start: (id: string) => Promise<void> };
  ensureInteractionReady: (contentsId: number) => Promise<void | boolean>;
  isTrustedHost: (senderId: number, url?: string) => boolean;
  getRecoveryError?: () => string | null;
  notify: (senderId: number, value: unknown) => void;
  onError?: (error: unknown) => void;
  startupTimeoutMs?: number;
  createBodyReader?: (contentsId: number) => BodyReader;
  getResponseBody: (
    contentsId: number,
    requestId: string,
    sessionId: string | null,
  ) => Promise<{ body: string; base64Encoded: boolean }>;
  getRequestPostData: (
    contentsId: number,
    requestId: string,
    sessionId: string | null,
  ) => Promise<{ postData: string }>;
}
interface ActiveRecording {
  recordingId: string;
  owner: number;
  browserId: string;
  browserIds: Set<string>;
  workspaceId: string;
  startedAt: number;
  budget: CaptureBudget;
  bodyReads: BodyReadGate;
  recorders: Map<number, { recorder: NetworkRecorder; reader: BodyReader }>;
  unattached: Map<number, RecordingMembership>;
  pending: Set<Promise<void>>;
  failures: unknown[];
  gaps: Map<string, { member: RecordingMembership; reason: string; count: number }>;
  stopping: boolean;
  started: boolean;
  interrupted: boolean;
  failureReason?: "quota" | "disk-full";
  failureDescription?: string;
  verifiedDocuments: Set<string>;
  finalization?: Promise<void>;
  stopped: Promise<void>;
  signalStop: () => void;
}
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const startInput = z.object({ browserId: z.string().min(1).max(256) }).strict();
const stopInput = z.object({ recordingId: identifier }).strict();
const readInput = z
  .object({
    recordingId: identifier,
    cursor: z.number().int().nonnegative(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
  })
  .strict();
const listInput = z.object({ workspaceId: z.string().min(1).max(2048) }).strict();
const listMediaInput = z
  .object({
    recordingId: identifier,
    cursor: z.string().max(1024).nullable(),
    limit: z.number().int().positive().max(100),
  })
  .strict();
function describeCaptureFailure(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (seen.has(value) || parts.length >= 8 || depth > 3) return;
    seen.add(value);
    const code =
      value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string"
        ? `${(value as NodeJS.ErrnoException).code}: `
        : "";
    parts.push(`${code}${String(value)}`.slice(0, 256));
    if (value instanceof AggregateError)
      for (const nested of value.errors) visit(nested, depth + 1);
    else if (value instanceof Error && value.cause) visit(value.cause, depth + 1);
  };
  visit(error, 0);
  return parts.join(": ").slice(0, 1024);
}
function storageFailureReason(error: unknown): "quota" | "disk-full" | null {
  const description = describeCaptureFailure(error);
  if (/\b(?:ENOSPC|EDQUOT)\b|no space left on device/i.test(description)) return "disk-full";
  if (/recording (?:storage )?quota (?:exceeded|reached)/i.test(description)) return "quota";
  return null;
}
const mediaInput = z
  .object({
    recordingId: identifier,
    streamId: identifier,
    segmentId: identifier,
    offset: z.number().int().nonnegative(),
    length: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
  })
  .strict();
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createRecordingBridge(options: Options) {
  const { registry, coordinator, store } = options;
  const active = new Map<string, ActiveRecording>();
  // A stuck Chromium command retains its physical slot until it settles.
  // Per-recording limits stop one recording exhausting the shared bound; if
  // all shared slots hang, later bodies are reported unavailable until restart.
  const bodyReads = new BodyReadGate(16, 64, 4000);
  const captureBudget = new CaptureBudget(64 * 1024 * 1024);
  const starting = new Map<string, string>();
  const notifyState = (recordingId: string, state: ActiveRecording, status: string) => {
    for (const browserId of state.browserIds)
      options.notify(state.owner, {
        recordingId,
        browserId,
        status,
        ...(state.failureReason && (status === "stopping" || status === "interrupted")
          ? { reason: state.failureReason }
          : {}),
      });
  };
  const reportStorageFailure = (recordingId: string, error: unknown) => {
    const state = active.get(recordingId);
    const reason = storageFailureReason(error);
    if (!state || !reason || state.failureReason) return;
    state.failureReason = reason;
    state.failureDescription = describeCaptureFailure(error);
    state.interrupted = true;
    notifyState(recordingId, state, "stopping");
    queueMicrotask(() => {
      if (active.get(recordingId) !== state || state.stopping) return;
      void stopOwned(recordingId, state).catch((failure: unknown) => options.onError?.(failure));
    });
  };
  const notifyInterrupted = (
    recordingId: string,
    state: ActiveRecording | undefined,
    owner: number,
    browserId: string,
  ) => {
    if (state) notifyState(recordingId, state, "interrupted");
    else options.notify(owner, { recordingId, browserId, status: "interrupted" });
  };
  const activeStatus = (state: ActiveRecording) => {
    if (state.stopping) return "stopping" as const;
    if (state.started) return "recording" as const;
    return "starting" as const;
  };
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0)
    throw new Error("Invalid startup timeout");
  const assertCaller = (caller: Caller) => {
    if (!caller.mainFrame || !options.isTrustedHost(caller.senderId, caller.url))
      throw new Error("Recording caller is not authorized");
  };
  const ownActive = (caller: Caller, recordingId: string) => {
    const state = active.get(recordingId);
    if (!state || state.owner !== caller.senderId)
      throw new Error("Recording is not owned by this window");
    return state;
  };
  const waitForStartup = async <T>(state: ActiveRecording, work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        state.stopped.then(() => {
          throw new Error(state.failureDescription ?? "Recording stopped during startup");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Recording startup timed out")),
            startupTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const track = (state: ActiveRecording, work: Promise<void>) => {
    state.pending.add(work);
    void work.then(
      () => state.pending.delete(work),
      (error: unknown) => {
        state.pending.delete(work);
        if (state.failures.length < 100) state.failures.push(error);
        reportStorageFailure(state.recordingId, error);
      },
    );
  };
  const recordGap = (member: RecordingMembership, reason: string) => {
    const state = active.get(member.recordingId);
    if (!state) return;
    const key =
      state.gaps.size >= 511 ? "gap-buffer-limit" : JSON.stringify([member.memberId, reason]);
    const existing = state.gaps.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    const gap = { member, reason: key === "gap-buffer-limit" ? key : reason, count: 1 };
    state.gaps.set(key, gap);
    track(
      state,
      store.appendEvent(member.recordingId, {
        recordingId: member.recordingId,
        memberId: member.memberId,
        webContentsId: member.webContentsId,
        frameAttribution: "unattributed",
        timelineMs: Math.max(0, Date.now() - state.startedAt),
        kind: "gap",
        payload: { reason: gap.reason, count: 1, summary: false },
      }),
    );
  };
  const attach = (member: RecordingMembership) => {
    const state = active.get(member.recordingId);
    if (!state || state.recorders.has(member.webContentsId)) return;
    if (
      state.recorders.size >= 32 ||
      [...active.values()].reduce((count, recording) => count + recording.recorders.size, 0) >= 64
    ) {
      recordGap(member, "network-view-limit");
      return;
    }
    let reader: BodyReader;
    try {
      reader = options.createBodyReader?.(member.webContentsId) ?? {
        getResponseBody: (id, sessionId) =>
          options.getResponseBody(member.webContentsId, id, sessionId),
        getRequestPostData: (id, sessionId) =>
          options.getRequestPostData(member.webContentsId, id, sessionId),
        release: async () => {},
      };
    } catch {
      state.unattached.set(member.webContentsId, member);
      return;
    }
    if (reader.ready) {
      const setup = withDeadline(reader.ready, 5000, "Network reader setup").catch(() => {
        recordGap(member, "network-reader-setup-failed");
      });
      track(state, setup);
    }
    const recorder = new NetworkRecorder({
      budget: state.budget,
      maxBodyBytes: 256 * 1024,
      maxActiveRequests: 64,
      maxPendingWrites: 64,
      maxBodyReads: 2,
      maxBodyQueue: 32,
      getResponseBody: (id, sessionId) =>
        state.bodyReads.run(() => bodyReads.run(() => reader.getResponseBody(id, sessionId))),
      getRequestPostData: (id, sessionId) =>
        state.bodyReads.run(() => bodyReads.run(() => reader.getRequestPostData(id, sessionId))),
      onGap: (reason) => recordGap(member, reason),
      write: async (transaction: NetworkTransaction) => {
        const frame =
          transaction.frameId && transaction.documentId
            ? coordinator.getFrame({
                webContentsId: member.webContentsId,
                frameId: transaction.frameId,
              })
            : null;
        const key = JSON.stringify([
          member.webContentsId,
          transaction.frameId,
          transaction.documentId,
        ]);
        const identified =
          (!!frame && frame.documentId === transaction.documentId) ||
          state.verifiedDocuments.has(key);
        await store
          .appendEvent(member.recordingId, {
            recordingId: member.recordingId,
            memberId: member.memberId,
            webContentsId: member.webContentsId,
            ...(identified
              ? { frameId: transaction.frameId!, documentId: transaction.documentId! }
              : {}),
            frameAttribution: identified ? "identified" : "unattributed",
            timelineMs: Math.max(
              0,
              (transaction.wallTime === null ? Date.now() : transaction.wallTime * 1000) -
                state.startedAt,
            ),
            kind: "network",
            payload: {
              ...transaction,
              frameAttribution: identified ? "identified" : "unattributed",
            },
          })
          .catch((error: unknown) => {
            reportStorageFailure(member.recordingId, error);
            throw error;
          });
      },
    });
    state.recorders.set(member.webContentsId, { recorder, reader });
    state.unattached.delete(member.webContentsId);
  };
  const detach = (state: ActiveRecording, contentsId: number) => {
    const unready = state.unattached.get(contentsId);
    if (unready) {
      state.unattached.delete(contentsId);
      recordGap(unready, "network-reader-unavailable");
    }
    const entry = state.recorders.get(contentsId);
    if (!entry) return;
    state.recorders.delete(contentsId);
    track(
      state,
      (async () => {
        const results = await Promise.allSettled([entry.recorder.close()]);
        await withDeadline(entry.reader.release(), 5000, "Network reader cleanup");
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Network recorder failed",
          );
      })(),
    );
  };
  const unsubscribe = coordinator.subscribe((change) => {
    const state = active.get(change.member.recordingId);
    if (!state) return;
    const browserId = change.member.browserId;
    if (browserId && change.type === "added") {
      state.browserIds.add(browserId);
      options.notify(state.owner, {
        recordingId: change.member.recordingId,
        browserId,
        status: state.started ? "recording" : "starting",
      });
    }
    if (browserId && change.type === "removed" && !state.stopping) {
      state.browserIds.delete(browserId);
      options.notify(state.owner, {
        recordingId: change.member.recordingId,
        browserId,
        status: "complete",
      });
    }
    if (change.type !== "added")
      detach(
        state,
        change.type === "replaced" ? change.previousWebContentsId : change.member.webContentsId,
      );
    if (change.type !== "removed") attach(change.member);
  });
  const unsubscribeStop = coordinator.subscribeStop(async (recordingId) => {
    const state = active.get(recordingId);
    if (!state) return;
    const externalStop = !state.stopping;
    state.stopping = true;
    if (state.started) notifyState(recordingId, state, "stopping");
    state.signalStop();
    queueMicrotask(() => {
      if (!externalStop || active.get(recordingId) !== state) return;
      void finalize(recordingId, state, coordinator.stop(recordingId)).catch((error: unknown) =>
        options.onError?.(error),
      );
    });
    for (const id of state.recorders.keys()) detach(state, id);
    for (const id of state.unattached.keys()) detach(state, id);
    while (state.pending.size) await Promise.allSettled(state.pending);
    state.bodyReads.close();
    for (const gap of state.gaps.values())
      if (gap.count > 1)
        track(
          state,
          store.appendEvent(recordingId, {
            recordingId,
            memberId: gap.member.memberId,
            webContentsId: gap.member.webContentsId,
            frameAttribution: "unattributed",
            timelineMs: Math.max(0, Date.now() - state.startedAt),
            kind: "gap",
            payload: { reason: gap.reason, count: gap.count, summary: true },
          }),
        );
    while (state.pending.size) await Promise.allSettled(state.pending);
    if (state.failures.length) throw new AggregateError(state.failures, "Network recording failed");
  });
  const finalize = (
    recordingId: string,
    state: ActiveRecording,
    completion: Promise<void>,
  ): Promise<void> => {
    if (state.finalization) return state.finalization;
    state.finalization = (async () => {
      try {
        await completion;
        const status = state.started && !state.interrupted ? "complete" : "interrupted";
        await store.updateMetadata(recordingId, {
          status,
          endedAt: Date.now(),
          ...(state.failureDescription ? { captureErrors: [state.failureDescription] } : {}),
        });
        notifyState(recordingId, state, status);
      } catch (error) {
        try {
          await store.updateMetadata(recordingId, {
            status: "interrupted",
            endedAt: Date.now(),
            captureErrors: [
              ...new Set(
                [state.failureDescription, describeCaptureFailure(error)].filter(
                  (value): value is string => Boolean(value),
                ),
              ),
            ],
          });
        } finally {
          notifyState(recordingId, state, "interrupted");
        }
        throw error;
      } finally {
        active.delete(recordingId);
      }
    })();
    return state.finalization;
  };
  const stopOwned = async (recordingId: string, state: ActiveRecording) => {
    if (state.stopping) {
      if (state.finalization) return state.finalization;
      return finalize(recordingId, state, coordinator.stop(recordingId));
    }
    state.stopping = true;
    state.signalStop();
    return finalize(recordingId, state, coordinator.stop(recordingId));
  };
  const stop = async (caller: Caller, input: unknown) => {
    assertCaller(caller);
    const { recordingId } = stopInput.parse(input);
    return stopOwned(recordingId, ownActive(caller, recordingId));
  };
  const rememberFrame = (
    state: ActiveRecording,
    contentsId: number,
    params: Record<string, unknown>,
  ) => {
    if (
      typeof params.frameId !== "string" ||
      typeof params.loaderId !== "string" ||
      params.frameId.length > 256 ||
      params.loaderId.length > 256
    )
      return;
    const frame = coordinator.getFrame({ webContentsId: contentsId, frameId: params.frameId });
    if (frame?.documentId !== params.loaderId) return;
    if (state.verifiedDocuments.size >= 4096)
      state.verifiedDocuments.delete(state.verifiedDocuments.values().next().value!);
    state.verifiedDocuments.add(JSON.stringify([contentsId, params.frameId, params.loaderId]));
  };
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      const outcomes = await Promise.allSettled(
        [...active].map(([recordingId, state]) => stopOwned(recordingId, state)),
      );
      bodyReads.close();
      unsubscribe();
      unsubscribeStop();
      const failed = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failed.length)
        throw new AggregateError(
          failed.map((outcome) => outcome.reason),
          "Recording shutdown failed",
        );
    })();
    return disposePromise;
  };
  return {
    reportStorageFailure,
    async active(caller: Caller, input: unknown) {
      assertCaller(caller);
      const { browserId } = startInput.parse(input);
      const member = coordinator.getBrowserMembership(caller.senderId, browserId);
      const entry = [...active.entries()].find(
        ([id, state]) =>
          state.owner === caller.senderId &&
          (id === member?.recordingId || state.browserIds.has(browserId)),
      );
      if (!entry) {
        const recordingId = starting.get(`${caller.senderId}:${browserId}`);
        return recordingId ? { recordingId, browserId, status: "starting" as const } : null;
      }
      const [recordingId, state] = entry;
      return { recordingId, browserId, status: activeStatus(state) };
    },
    async start(caller: Caller, input: unknown) {
      assertCaller(caller);
      if (disposePromise) throw new Error("Recording bridge is closed");
      const { browserId } = startInput.parse(input);
      const contentsId = registry.getWebContentsIdForBrowserInHostWindow(
        caller.senderId,
        browserId,
      );
      const workspaceId = registry.getWorkspaceId(browserId);
      if (contentsId === null || !workspaceId)
        throw new Error("Browser is not owned by this window");
      const key = `${caller.senderId}:${browserId}`;
      const pendingOnly = [...starting.keys()].filter(
        (item) =>
          ![...active.values()].some((state) => `${state.owner}:${state.browserId}` === item),
      ).length;
      if (active.size + pendingOnly >= 16) throw new Error("Recording limit reached");
      if (starting.has(key) || coordinator.getBrowserMembership(caller.senderId, browserId))
        throw new Error("Browser is already recording");
      const recordingId = randomUUID();
      const startedAt = Date.now();
      starting.set(key, recordingId);
      let created = false;
      try {
        await store.create({
          recordingId,
          workspaceId,
          startedAt,
          status: "recording",
        });
        created = true;
        let signalStop!: () => void;
        const stopped = new Promise<void>((resolve) => {
          signalStop = resolve;
        });
        const state: ActiveRecording = {
          recordingId,
          owner: caller.senderId,
          browserId,
          browserIds: new Set([browserId]),
          workspaceId,
          startedAt,
          budget: new CaptureBudget(32 * 1024 * 1024, captureBudget),
          bodyReads: new BodyReadGate(2, 16, 4000),
          recorders: new Map(),
          unattached: new Map(),
          pending: new Set(),
          failures: [],
          gaps: new Map(),
          stopping: false,
          started: false,
          interrupted: false,
          verifiedDocuments: new Set(),
          stopped,
          signalStop,
        };
        active.set(recordingId, state);
        const member = coordinator.start({
          recordingId,
          hostWebContentsId: caller.senderId,
          browserId,
          sink: {
            write: (event) => {
              if (event.payload === undefined)
                return Promise.reject(new Error("Recording payload is missing"));
              const payload = event.payload as { receivedAt?: unknown } | null;
              const time =
                typeof payload?.receivedAt === "number" && Number.isFinite(payload.receivedAt)
                  ? payload.receivedAt
                  : Date.now();
              return store
                .appendEvent(recordingId, {
                  ...event,
                  timelineMs: event.timelineMs ?? Math.max(0, time - startedAt),
                  payload: event.payload,
                })
                .catch((error: unknown) => {
                  reportStorageFailure(recordingId, error);
                  throw error;
                });
            },
          },
        });
        const interactionReady = await waitForStartup(
          state,
          options.ensureInteractionReady(contentsId),
        );
        if (interactionReady === false)
          await coordinator.reportGap({
            recordingId,
            memberId: member.memberId,
            reason: "interaction-startup-unverified",
          });
        if (state.stopping) throw new Error("Recording stopped during startup");
        await waitForStartup(state, options.video.start(recordingId));
        if (state.stopping) throw new Error("Recording stopped during startup");
        state.started = true;
        notifyState(recordingId, state, "recording");
        return { recordingId, status: "recording" };
      } catch (error) {
        const state = active.get(recordingId);
        if (state?.finalization) {
          await state.finalization.catch(() => {});
          throw error;
        }
        if (state) {
          state.stopping = true;
          state.signalStop();
        }
        await coordinator.stop(recordingId).catch(() => {});
        try {
          if (created) {
            try {
              await store.updateMetadata(recordingId, {
                status: "interrupted",
                endedAt: Date.now(),
                captureErrors: [describeCaptureFailure(error)],
              });
            } finally {
              notifyInterrupted(recordingId, state, caller.senderId, browserId);
            }
          }
        } finally {
          active.delete(recordingId);
        }
        throw error;
      } finally {
        starting.delete(key);
      }
    },
    stop,
    async listMedia(caller: Caller, input: unknown) {
      assertCaller(caller);
      const { recordingId, cursor, limit } = listMediaInput.parse(input);
      const state = active.get(recordingId);
      if (state && state.owner !== caller.senderId)
        throw new Error("Recording is not owned by this window");
      if (state) return { segments: [], incomplete: [], nextCursor: null, pending: true };
      return { ...(await store.listMediaSegmentsPage(recordingId, cursor, limit)), pending: false };
    },
    async readEvents(caller: Caller, input: unknown) {
      // Saved recordings belong to the local app; trusted app windows share access.
      // An active session remains bound to the window that started it.
      assertCaller(caller);
      const { recordingId, cursor, maxBytes } = readInput.parse(input);
      const state = active.get(recordingId);
      if (state && state.owner !== caller.senderId)
        throw new Error("Recording is not owned by this window");
      return store.inspectEventsPage(recordingId, { cursor, maxBytes });
    },
    async list(caller: Caller, input: unknown) {
      assertCaller(caller);
      const { workspaceId } = listInput.parse(input);
      const result = await store.list();
      return {
        recordings: result.recordings.filter((recording) => recording.workspaceId === workspaceId),
        incomplete: result.incomplete,
        recoveryError: options.getRecoveryError?.() ?? null,
      };
    },
    async readMedia(caller: Caller, input: unknown) {
      assertCaller(caller);
      const { recordingId, streamId, segmentId, offset, length } = mediaInput.parse(input);
      const state = active.get(recordingId);
      if (state && state.owner !== caller.senderId)
        throw new Error("Recording is not owned by this window");
      const result = await store.readMediaSegmentRange(recordingId, streamId, segmentId, {
        offset,
        length,
      });
      return { ...result, bytes: Uint8Array.from(result.bytes) };
    },
    async delete(caller: Caller, input: unknown) {
      assertCaller(caller);
      const { recordingId } = stopInput.parse(input);
      if (active.has(recordingId)) throw new Error("Recording is active");
      await store.delete(recordingId);
      await coordinator.forgetStopped(recordingId);
    },
    onCdpEvent(
      contentsId: number,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) {
      const member = coordinator.getMembership(contentsId);
      const state = member && active.get(member.recordingId);
      if (state?.stopping) return;
      if (state && method === "Network.requestWillBeSent") rememberFrame(state, contentsId, params);
      let recorder = state?.recorders.get(contentsId)?.recorder;
      if (state && member && !recorder && method.startsWith("Network.")) {
        attach(member);
        recorder = state.recorders.get(contentsId)?.recorder;
        if (!recorder) recordGap(member, "network-recorder-not-ready");
      }
      if (recorder)
        void recorder
          .handle({ method, params, ...(sessionId ? { sessionId } : {}) })
          .catch((error: unknown) => {
            if (state && state.failures.length < 100) state.failures.push(error);
          });
    },
    dispose,
    async shutdown() {
      for (const state of active.values()) state.interrupted = true;
      await dispose();
    },
    async hostClosed(senderId: number) {
      const recordings = [...active].filter(([, state]) => state.owner === senderId);
      for (const [, state] of recordings) state.interrupted = true;
      const outcomes = await Promise.allSettled(
        recordings.map(([recordingId, state]) => stopOwned(recordingId, state)),
      );
      const failures = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Recording host cleanup failed",
        );
    },
  };
}
