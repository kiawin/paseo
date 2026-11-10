import { randomUUID } from "node:crypto";
import type { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";

export type RecordingEventKind = "interaction" | "network" | "media" | "gap";
export type RecordingDropReason =
  | "unknown-contents"
  | "stale-member"
  | "invalid-attribution"
  | "unregistered-frame"
  | "stale-document"
  | "invalid-kind";

export interface RecordingEvent {
  recordingId: string;
  memberId: string;
  webContentsId: number;
  frameId?: string;
  documentId?: string;
  frameAttribution: "identified" | "unattributed";
  kind: RecordingEventKind;
  payload: unknown;
}

export interface RecordingEventSink {
  // Concurrent writes can arrive in order but settle out of order. The sink
  // owns serialization of durable appends and any backpressure policy.
  write(event: RecordingEvent): Promise<void>;
  close?(): Promise<void>;
}

export interface RecordingMembership {
  recordingId: string;
  memberId: string;
  parentMemberId: string | null;
  browserId: string | null;
  webContentsId: number;
  hostWebContentsId: number;
  workspaceId: string;
}

export type RecordingMembershipChange =
  | { type: "added" | "removed"; member: RecordingMembership }
  | { type: "replaced"; member: RecordingMembership; previousWebContentsId: number };

interface RecordingSession {
  recordingId: string;
  hostWebContentsId: number;
  workspaceId: string;
  sink: RecordingEventSink;
  pendingWrites: Set<Promise<void>>;
  failures: unknown[];
  failureCount: number;
  members: Map<string, RecordingMembership>;
  dropped: Map<string, number>;
  gaps: Map<string, RecordingGap>;
  claimedPopups: Set<number>;
}

interface RecordingGap {
  member: RecordingMembership;
  reason: string;
  droppedKind: string;
  count: number;
  firstAtMs: number;
  lastAtMs: number;
  sampleFrameId?: string;
  sampleDocumentId?: string;
}

interface PendingTabOpen {
  recordingId: string;
  parentMemberId: string;
  browserId: string;
  expiresAt: number;
}

interface CoordinatorOptions {
  now?: () => number;
  pendingTabTtlMs?: number;
  maxPendingTabs?: number;
}

export class BrowserRecordingCoordinator {
  private readonly sessions = new Map<string, RecordingSession>();
  private readonly stopped = new Map<string, Promise<void>>();
  private readonly contents = new Map<number, RecordingMembership>();
  private readonly browsers = new Map<string, RecordingMembership>();
  private readonly pendingTabs = new Map<string, PendingTabOpen>();
  private readonly frames = new Map<number, Map<string, string>>();
  private readonly listeners = new Set<(change: RecordingMembershipChange) => void>();
  private readonly now: () => number;
  private readonly pendingTabTtlMs: number;
  private readonly maxPendingTabs: number;

  public constructor(
    private readonly registry: PaseoBrowserWebviewRegistry,
    private readonly isPopupChild: (
      openerWebContentsId: number,
      popupWebContentsId: number,
    ) => boolean,
    options: CoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pendingTabTtlMs = options.pendingTabTtlMs ?? 30_000;
    this.maxPendingTabs = options.maxPendingTabs ?? 128;
    if (
      !Number.isFinite(this.pendingTabTtlMs) ||
      this.pendingTabTtlMs <= 0 ||
      !Number.isSafeInteger(this.maxPendingTabs) ||
      this.maxPendingTabs <= 0
    )
      throw new Error("Invalid tab reservation limits");
  }

  // The host identity must be derived from the trusted IPC sender, not payload data.
  public start(input: {
    recordingId: string;
    hostWebContentsId: number;
    browserId: string;
    sink: RecordingEventSink;
  }): RecordingMembership {
    if (
      !input.recordingId.trim() ||
      this.sessions.has(input.recordingId) ||
      this.stopped.has(input.recordingId)
    ) {
      throw new Error("Recording identity is empty or already in use");
    }
    const webContentsId = this.registry.getWebContentsIdForBrowserInHostWindow(
      input.hostWebContentsId,
      input.browserId,
    );
    const workspaceId = this.registry.getWorkspaceId(input.browserId);
    if (webContentsId === null || !workspaceId)
      throw new Error("Browser is not registered in this host and workspace");
    this.assertBrowserAvailable(input.hostWebContentsId, input.browserId);
    this.assertContentsAvailable(webContentsId);
    const session: RecordingSession = {
      recordingId: input.recordingId,
      hostWebContentsId: input.hostWebContentsId,
      workspaceId,
      sink: input.sink,
      pendingWrites: new Set(),
      failures: [],
      failureCount: 0,
      members: new Map(),
      dropped: new Map(),
      gaps: new Map(),
      claimedPopups: new Set(),
    };
    this.sessions.set(input.recordingId, session);
    return this.addMember(session, {
      browserId: input.browserId,
      webContentsId,
      parentMemberId: null,
    });
  }

  // The trusted open handler forwards both values to the renderer. The browser
  // ID is minted here, bound to this one-use reservation and cannot name an
  // already-open tab. Claims are consumed even when validation fails.
  public reserveTabOpen(openerWebContentsId: number): { token: string; browserId: string } {
    const parent = this.requireMembership(openerWebContentsId);
    this.prunePendingTabs();
    const count = Array.from(this.pendingTabs.values()).filter(
      (entry) => entry.recordingId === parent.recordingId,
    ).length;
    if (count >= this.maxPendingTabs) throw new Error("Too many pending tab opens");
    const token = randomUUID();
    let browserId = randomUUID();
    while (this.registry.listBrowserIds().includes(browserId)) browserId = randomUUID();
    this.pendingTabs.set(token, {
      recordingId: parent.recordingId,
      parentMemberId: parent.memberId,
      browserId,
      expiresAt: this.now() + this.pendingTabTtlMs,
    });
    return { token, browserId };
  }

  // hostWebContentsId must come from the trusted IPC sender. T07's open hook
  // must report a gap for reservation or claim failures it can attribute.
  public claimTabOpen(input: {
    token: string;
    hostWebContentsId: number;
    browserId: string;
  }): RecordingMembership {
    const pending = this.pendingTabs.get(input.token);
    this.pendingTabs.delete(input.token);
    const session = pending && this.sessions.get(pending.recordingId);
    if (
      !pending ||
      pending.expiresAt <= this.now() ||
      !session ||
      !session.members.has(pending.parentMemberId)
    ) {
      throw new Error("Tab open is not associated with a live recording");
    }
    if (
      input.browserId !== pending.browserId ||
      input.hostWebContentsId !== session.hostWebContentsId ||
      this.registry.getWorkspaceId(input.browserId) !== session.workspaceId
    ) {
      throw new Error("Opened tab does not match the reserved host and workspace");
    }
    const webContentsId = this.registry.getWebContentsIdForBrowserInHostWindow(
      input.hostWebContentsId,
      input.browserId,
    );
    if (webContentsId === null) throw new Error("Opened tab is not registered");
    this.assertBrowserAvailable(input.hostWebContentsId, input.browserId);
    this.assertContentsAvailable(webContentsId);
    return this.addMember(session, {
      browserId: input.browserId,
      webContentsId,
      parentMemberId: pending.parentMemberId,
    });
  }

  // Call synchronously from the trusted window-open hook. Its validator must
  // verify the actual opener/child event with a one-shot entry, not a lasting map.
  // T07 must report an attributable gap on the opener if admission fails.
  public addPopupFromOpen(input: {
    openerWebContentsId: number;
    popupWebContentsId: number;
  }): RecordingMembership {
    const parent = this.requireMembership(input.openerWebContentsId);
    const session = this.sessions.get(parent.recordingId)!;
    this.assertContentsAvailable(input.popupWebContentsId);
    if (
      session.claimedPopups.has(input.popupWebContentsId) ||
      !this.isPopupChild(input.openerWebContentsId, input.popupWebContentsId)
    )
      throw new Error("Popup opener does not match a new recording event");
    if (this.registry.getRegistrationForWebContents(input.popupWebContentsId))
      throw new Error("Popup contents are already registered as a browser tab");
    session.claimedPopups.add(input.popupWebContentsId);
    return this.addMember(session, {
      browserId: null,
      webContentsId: input.popupWebContentsId,
      parentMemberId: parent.memberId,
    });
  }

  // T07 must call this synchronously from the trusted registry registration
  // hook. Events from unknown contents are rejected without a sink gap because
  // they cannot safely be attributed to a recording.
  public replaceBrowserGuest(input: {
    hostWebContentsId: number;
    browserId: string;
  }): RecordingMembership {
    const key = this.browserKey(input.hostWebContentsId, input.browserId);
    const member = this.browsers.get(key);
    const nextId = this.registry.getWebContentsIdForBrowserInHostWindow(
      input.hostWebContentsId,
      input.browserId,
    );
    if (!member) {
      throw new Error("Replacement browser is not registered for this recording");
    }
    if (nextId === null || this.registry.getWorkspaceId(input.browserId) !== member.workspaceId) {
      this.scheduleReplacementGap(member);
      throw new Error("Replacement browser is not registered for this recording");
    }
    if (member.webContentsId === nextId) return { ...member };
    try {
      this.assertContentsAvailable(nextId);
    } catch (error) {
      this.scheduleReplacementGap(member);
      throw error;
    }
    const previousWebContentsId = member.webContentsId;
    this.contents.delete(previousWebContentsId);
    this.frames.delete(previousWebContentsId);
    member.webContentsId = nextId;
    this.contents.set(nextId, member);
    this.notify({ type: "replaced", member: { ...member }, previousWebContentsId });
    return { ...member };
  }

  public getMembership(webContentsId: number): RecordingMembership | null {
    const member = this.contents.get(webContentsId);
    return member && this.isCurrent(member) ? { ...member } : null;
  }

  public getBrowserMembership(
    hostWebContentsId: number,
    browserId: string,
  ): RecordingMembership | null {
    const member = this.browsers.get(this.browserKey(hostWebContentsId, browserId));
    return member ? { ...member } : null;
  }

  public listMemberships(recordingId: string): RecordingMembership[] {
    return Array.from(this.sessions.get(recordingId)?.members.values() ?? [], (member) => ({
      ...member,
    }));
  }

  public subscribe(listener: (change: RecordingMembershipChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public registerFrame(input: {
    webContentsId: number;
    frameId: string;
    documentId: string;
  }): void {
    this.requireMembership(input.webContentsId);
    if (!input.frameId || !input.documentId)
      throw new Error("Frame and document identities are required");
    const frames = this.frames.get(input.webContentsId) ?? new Map<string, string>();
    frames.set(input.frameId, input.documentId);
    this.frames.set(input.webContentsId, frames);
  }

  public removeFrame(input: { webContentsId: number; frameId: string }): void {
    const frames = this.frames.get(input.webContentsId);
    frames?.delete(input.frameId);
    if (frames?.size === 0) this.frames.delete(input.webContentsId);
  }

  public getFrame(input: {
    webContentsId: number;
    frameId: string;
  }): { frameId: string; documentId: string } | null {
    if (!this.getMembership(input.webContentsId)) return null;
    const documentId = this.frames.get(input.webContentsId)?.get(input.frameId);
    return documentId ? { frameId: input.frameId, documentId } : null;
  }

  public getDropCount(recordingId: string, webContentsId: number): number {
    const member = this.contents.get(webContentsId);
    return member?.recordingId === recordingId
      ? (this.sessions.get(recordingId)?.dropped.get(member.memberId) ?? 0)
      : 0;
  }

  // Trusted lifecycle hooks use this when a gap can be attributed to a member
  // but no current guest exists from which emit() could derive its identity.
  public async reportGap(input: {
    recordingId: string;
    memberId: string;
    reason: string;
  }): Promise<boolean> {
    const session = this.sessions.get(input.recordingId);
    const member = session?.members.get(input.memberId);
    if (!session || !member || !input.reason.trim()) return false;
    await this.writeGap(session, member, input.reason, "lifecycle");
    return true;
  }

  public async emit(input: {
    webContentsId: number;
    frameId?: string;
    documentId?: string;
    kind: Exclude<RecordingEventKind, "gap">;
    payload: unknown;
  }): Promise<{ ok: true } | { ok: false; reason: RecordingDropReason }> {
    const member = this.contents.get(input.webContentsId);
    if (!member) return { ok: false, reason: "unknown-contents" };
    const session = this.sessions.get(member.recordingId);
    if (!session) return { ok: false, reason: "unknown-contents" };
    let reason: RecordingDropReason | null = null;
    if (!this.isCurrent(member)) reason = "stale-member";
    else if (!["interaction", "network", "media"].includes(input.kind)) reason = "invalid-kind";
    else if (input.frameId !== undefined || input.documentId !== undefined) {
      if (!input.frameId || !input.documentId) reason = "invalid-attribution";
      else {
        const frame = this.frames.get(input.webContentsId)?.get(input.frameId);
        if (!frame) reason = "unregistered-frame";
        else if (frame !== input.documentId) reason = "stale-document";
      }
    }
    if (reason) {
      await this.writeGap(session, member, reason, input.kind, input.frameId, input.documentId);
      return { ok: false, reason };
    }
    await this.write(session, {
      recordingId: member.recordingId,
      memberId: member.memberId,
      webContentsId: input.webContentsId,
      ...(input.frameId !== undefined ? { frameId: input.frameId } : {}),
      ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
      frameAttribution: input.frameId ? "identified" : "unattributed",
      kind: input.kind,
      payload: input.payload,
    });
    return { ok: true };
  }

  // Call only for a logical close, not a guest being replaced during reparenting.
  public async removeMember(
    webContentsId: number,
    reason: "closed" | "host-closed",
  ): Promise<void> {
    const member = this.contents.get(webContentsId);
    if (!member) return;
    const session = this.sessions.get(member.recordingId);
    if (!session) return;
    if (member.parentMemberId === null) {
      const gap = this.writeGap(
        session,
        member,
        reason === "closed" ? "root-closed" : reason,
        "lifecycle",
      );
      void gap.catch(() => {});
      await this.stop(session.recordingId);
      return;
    }
    this.removeMemberIndexes(session, member);
    await this.writeGap(session, member, reason, "lifecycle");
  }

  public async handleBrowserUnregistered(input: {
    hostWebContentsId: number;
    browserId: string;
  }): Promise<void> {
    const member = this.browsers.get(this.browserKey(input.hostWebContentsId, input.browserId));
    if (member) await this.removeMember(member.webContentsId, "closed");
  }

  public async handleHostClosed(hostWebContentsId: number): Promise<void> {
    const sessions = Array.from(this.sessions.values()).filter(
      (session) => session.hostWebContentsId === hostWebContentsId,
    );
    const outcomes = await Promise.allSettled(
      sessions.map(async (session) => {
        const root = Array.from(session.members.values()).find(
          (member) => member.parentMemberId === null,
        );
        if (root) await this.removeMember(root.webContentsId, "host-closed");
      }),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Recording cleanup failed after host closed");
  }

  public stop(recordingId: string): Promise<void> {
    const previous = this.stopped.get(recordingId);
    if (previous) return previous;
    const session = this.sessions.get(recordingId);
    if (!session) return Promise.resolve();
    this.sessions.delete(recordingId);
    for (const member of Array.from(session.members.values()))
      this.removeMemberIndexes(session, member);
    for (const [token, pending] of this.pendingTabs)
      if (pending.recordingId === recordingId) this.pendingTabs.delete(token);
    for (const gap of session.gaps.values()) {
      if (gap.count > 1) void this.write(session, this.gapEvent(gap, true)).catch(() => {});
    }
    const completion = (async () => {
      await Promise.allSettled(session.pendingWrites);
      try {
        await session.sink.close?.();
      } catch (error) {
        this.rememberFailure(session, error);
      }
      if (session.failureCount)
        throw new AggregateError(
          session.failures,
          `Recording writes failed during stop (${session.failureCount}): ${session.failures.map(String).join("; ")}`,
        );
    })();
    this.stopped.set(recordingId, completion);
    return completion;
  }

  // Called after the saved recording and any associated resources are deleted.
  public async forgetStopped(recordingId: string): Promise<void> {
    if (this.sessions.has(recordingId)) throw new Error("Recording is still active");
    const completion = this.stopped.get(recordingId);
    if (!completion) return;
    await completion.catch(() => {});
    if (this.stopped.get(recordingId) === completion) this.stopped.delete(recordingId);
  }

  private write(session: RecordingSession, event: RecordingEvent): Promise<void> {
    const pending = Promise.resolve()
      .then(() => session.sink.write(event))
      .catch((error: unknown) => {
        this.rememberFailure(session, error);
        throw error;
      });
    session.pendingWrites.add(pending);
    void pending.then(
      () => session.pendingWrites.delete(pending),
      () => session.pendingWrites.delete(pending),
    );
    return pending;
  }

  private writeGap(
    session: RecordingSession,
    member: RecordingMembership,
    reason: string,
    droppedKind: string,
    frameId?: string,
    documentId?: string,
  ): Promise<void> {
    session.dropped.set(member.memberId, (session.dropped.get(member.memberId) ?? 0) + 1);
    const safeReason = reason.slice(0, 128);
    let key = JSON.stringify([member.memberId, member.webContentsId, safeReason, droppedKind]);
    const memberGapCount = Array.from(session.gaps.values()).filter(
      (gap) => gap.member.memberId === member.memberId,
    ).length;
    if (!session.gaps.has(key) && memberGapCount >= 64)
      key = JSON.stringify([member.memberId, "overflow"]);
    const existing = session.gaps.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAtMs = this.now();
      return Promise.resolve();
    }
    const overflow = memberGapCount >= 64;
    const now = this.now();
    const gap: RecordingGap = {
      member: { ...member },
      reason: overflow ? "gap-overflow" : safeReason,
      droppedKind: overflow ? "mixed" : droppedKind,
      count: 1,
      firstAtMs: now,
      lastAtMs: now,
      ...(frameId !== undefined ? { sampleFrameId: frameId.slice(0, 256) } : {}),
      ...(documentId !== undefined ? { sampleDocumentId: documentId.slice(0, 256) } : {}),
    };
    session.gaps.set(key, gap);
    return this.write(session, this.gapEvent(gap, false));
  }

  private gapEvent(gap: RecordingGap, summary: boolean): RecordingEvent {
    return {
      recordingId: gap.member.recordingId,
      memberId: gap.member.memberId,
      webContentsId: gap.member.webContentsId,
      kind: "gap",
      frameAttribution: "unattributed",
      payload: {
        reason: gap.reason,
        droppedKind: gap.droppedKind,
        count: summary ? gap.count : 1,
        firstAtMs: gap.firstAtMs,
        lastAtMs: gap.lastAtMs,
        summary,
        sampleFrameId: gap.sampleFrameId,
        sampleDocumentId: gap.sampleDocumentId,
        additionalContextsMayDiffer: summary,
      },
    };
  }

  private rememberFailure(session: RecordingSession, error: unknown): void {
    session.failureCount += 1;
    if (session.failures.length < 100) session.failures.push(error);
  }

  private scheduleReplacementGap(member: RecordingMembership): void {
    const session = this.sessions.get(member.recordingId);
    if (!session) return;
    void this.writeGap(session, member, "replacement-failed", "lifecycle").catch(() => {});
  }

  private addMember(
    session: RecordingSession,
    input: { browserId: string | null; webContentsId: number; parentMemberId: string | null },
  ): RecordingMembership {
    const member: RecordingMembership = {
      recordingId: session.recordingId,
      memberId: randomUUID(),
      parentMemberId: input.parentMemberId,
      browserId: input.browserId,
      webContentsId: input.webContentsId,
      hostWebContentsId: session.hostWebContentsId,
      workspaceId: session.workspaceId,
    };
    session.members.set(member.memberId, member);
    this.contents.set(member.webContentsId, member);
    if (member.browserId)
      this.browsers.set(this.browserKey(member.hostWebContentsId, member.browserId), member);
    this.notify({ type: "added", member: { ...member } });
    return { ...member };
  }

  private removeMemberIndexes(session: RecordingSession, member: RecordingMembership): void {
    this.contents.delete(member.webContentsId);
    this.frames.delete(member.webContentsId);
    session.members.delete(member.memberId);
    if (member.browserId)
      this.browsers.delete(this.browserKey(member.hostWebContentsId, member.browserId));
    for (const [token, pending] of this.pendingTabs)
      if (pending.recordingId === session.recordingId && pending.parentMemberId === member.memberId)
        this.pendingTabs.delete(token);
    this.notify({ type: "removed", member: { ...member } });
  }

  private requireMembership(webContentsId: number): RecordingMembership {
    const member = this.contents.get(webContentsId);
    if (!member || !this.sessions.has(member.recordingId) || !this.isCurrent(member))
      throw new Error("Contents are not part of an active recording");
    return member;
  }

  private isCurrent(member: RecordingMembership): boolean {
    if (!member.browserId) return true;
    return (
      this.registry.getWebContentsIdForBrowserInHostWindow(
        member.hostWebContentsId,
        member.browserId,
      ) === member.webContentsId &&
      this.registry.getWorkspaceId(member.browserId) === member.workspaceId
    );
  }

  private assertContentsAvailable(webContentsId: number): void {
    if (
      !Number.isSafeInteger(webContentsId) ||
      webContentsId <= 0 ||
      this.contents.has(webContentsId)
    )
      throw new Error("Contents are invalid or already being recorded");
  }

  private assertBrowserAvailable(hostWebContentsId: number, browserId: string): void {
    if (this.browsers.has(this.browserKey(hostWebContentsId, browserId)))
      throw new Error("Browser is already being recorded");
  }

  private browserKey(hostWebContentsId: number, browserId: string): string {
    return JSON.stringify([hostWebContentsId, browserId]);
  }

  private prunePendingTabs(): void {
    const now = this.now();
    for (const [token, pending] of this.pendingTabs)
      if (pending.expiresAt <= now) this.pendingTabs.delete(token);
  }

  private notify(change: RecordingMembershipChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        console.warn("[browser-recording] membership listener failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }
}
