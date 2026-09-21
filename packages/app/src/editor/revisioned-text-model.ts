export type RevisionedTextStatus = "clean" | "dirty" | "saving" | "conflict" | "error";
export type RevisionedTextLineSeparator = "\n" | "\r\n" | "\r";

export interface RevisionedTextSnapshot<TVersion, TReplacedRevision> {
  status: RevisionedTextStatus;
  content: string;
  lineSeparator: RevisionedTextLineSeparator;
  modified: boolean;
  version: TVersion;
  observedVersion: TVersion;
  replacedRevision: TReplacedRevision | null;
  error: string | null;
}

export interface RevisionedTextDocument<TVersion, TFormat> {
  content: string;
  format: TFormat;
  version: TVersion;
}

export type RevisionedTextObservation<TVersion, TFormat> =
  | { status: "ready"; document: RevisionedTextDocument<TVersion, TFormat> }
  | { status: "missing"; version: TVersion }
  | { status: "error"; version: TVersion; error: string };

export type RevisionedTextWriteOutcome<TVersion, TReplacedRevision> =
  | {
      status: "written";
      version: TVersion;
      replacedRevision: TReplacedRevision | null;
    }
  | { status: "conflict"; version: TVersion }
  | { status: "error"; error: string };

export interface RevisionedTextAdapter<
  TVersion,
  TObservation,
  TWriteResult,
  TFormat,
  TReplacedRevision,
> {
  initial: RevisionedTextDocument<TVersion, TFormat>;
  observe(observation: TObservation): RevisionedTextObservation<TVersion, TFormat>;
  write(input: {
    content: string;
    format: TFormat;
    expectedVersion: TVersion;
  }): Promise<TWriteResult>;
  resolveWrite(
    result: TWriteResult,
    expectedVersion: TVersion,
  ): RevisionedTextWriteOutcome<TVersion, TReplacedRevision>;
  documentsEqual(
    left: RevisionedTextDocument<TVersion, TFormat>,
    right: RevisionedTextDocument<TVersion, TFormat>,
  ): boolean;
}

export interface RevisionedTextClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemClock: RevisionedTextClock = {
  setTimeout(callback, delay) {
    return globalThis.setTimeout(callback, delay);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle);
  },
};

type ObservedState<TVersion, TFormat> =
  | RevisionedTextObservation<TVersion, TFormat>
  | { status: "unsettled"; version: TVersion };

export class RevisionedTextModel<TVersion, TObservation, TWriteResult, TFormat, TReplacedRevision> {
  private readonly adapter: RevisionedTextAdapter<
    TVersion,
    TObservation,
    TWriteResult,
    TFormat,
    TReplacedRevision
  >;
  private readonly clock: RevisionedTextClock;
  private readonly listeners = new Set<() => void>();
  private snapshot: RevisionedTextSnapshot<TVersion, TReplacedRevision>;
  private autosave: ReturnType<typeof setTimeout> | null = null;
  private saveSequence = 0;
  private inFlightSaveSequence: number | null = null;
  private disposed = false;
  private observedWhileSaving: RevisionedTextObservation<TVersion, TFormat> | null = null;
  private observed: ObservedState<TVersion, TFormat>;
  private lastReceivedObservation: TObservation | null = null;
  private refreshObservation: (() => void) | null = null;
  private reloadRequested = false;
  private persistedContent: string;
  private format: TFormat;
  private unsubscribeObservationSource: (() => void) | null = null;

  constructor(input: {
    adapter: RevisionedTextAdapter<
      TVersion,
      TObservation,
      TWriteResult,
      TFormat,
      TReplacedRevision
    >;
    clock?: RevisionedTextClock;
  }) {
    this.adapter = input.adapter;
    this.clock = input.clock ?? systemClock;
    this.persistedContent = input.adapter.initial.content;
    this.format = input.adapter.initial.format;
    this.observed = { status: "ready", document: input.adapter.initial };
    this.snapshot = {
      status: "clean",
      content: input.adapter.initial.content,
      lineSeparator: detectLineSeparator(input.adapter.initial.content),
      modified: false,
      version: input.adapter.initial.version,
      observedVersion: input.adapter.initial.version,
      replacedRevision: null,
      error: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RevisionedTextSnapshot<TVersion, TReplacedRevision> => this.snapshot;

  connectObservations(source: {
    subscribe(listener: () => void): () => void;
    getObservation(): TObservation | null;
    refresh(): void;
  }): void {
    this.disconnectObservations();
    this.refreshObservation = source.refresh;
    const receiveObservation = () => {
      const observation = source.getObservation();
      if (observation) this.receiveObservation(observation);
    };
    this.unsubscribeObservationSource = source.subscribe(receiveObservation);
    receiveObservation();
  }

  disconnectObservations(): void {
    this.unsubscribeObservationSource?.();
    this.unsubscribeObservationSource = null;
    this.refreshObservation = null;
  }

  edit(content: string): void {
    if (this.disposed || content === this.snapshot.content) return;
    this.reloadRequested = false;
    const modified = content !== this.persistedContent;
    let status: RevisionedTextStatus = modified ? "dirty" : "clean";
    if (this.snapshot.status === "conflict") {
      status = "conflict";
    }
    this.setSnapshot({ ...this.snapshot, status, content, modified, error: null });
    if (status === "dirty") this.scheduleAutosave();
    else this.clearAutosave();
  }

  async save(): Promise<void> {
    if (
      this.disposed ||
      this.inFlightSaveSequence !== null ||
      (this.snapshot.status !== "dirty" && this.snapshot.status !== "error")
    ) {
      return;
    }
    if (isUnavailableVersion(this.snapshot.observedVersion)) {
      this.enterConflict(this.snapshot.observedVersion);
      return;
    }
    await this.performWrite(this.snapshot.observedVersion);
  }

  receiveObservation(observation: TObservation): void {
    if (this.disposed || observation === this.lastReceivedObservation) return;
    this.lastReceivedObservation = observation;
    const resolved = this.adapter.observe(observation);
    this.observed = resolved;
    this.setSnapshot({ ...this.snapshot, observedVersion: observationVersion(resolved) });
    if (this.inFlightSaveSequence !== null) {
      this.observedWhileSaving = resolved;
      return;
    }
    if (resolved.status !== "ready") {
      this.reloadRequested = false;
      this.enterConflict(observationVersion(resolved));
      return;
    }
    if (this.reloadRequested) {
      this.reloadRequested = false;
      this.applyDocument(resolved.document);
      return;
    }
    if (this.documentsMatchPersisted(resolved.document)) {
      this.adoptUnchangedDocument(resolved.document);
      return;
    }
    if (this.snapshot.status === "clean") {
      this.applyDocument(resolved.document);
      return;
    }
    this.enterConflict(resolved.document.version);
  }

  async overwrite(): Promise<void> {
    if (
      this.disposed ||
      this.inFlightSaveSequence !== null ||
      this.snapshot.status !== "conflict"
    ) {
      return;
    }
    if (isUnavailableVersion(this.snapshot.observedVersion)) return;
    await this.performWrite(this.snapshot.observedVersion);
  }

  async reload(): Promise<void> {
    if (this.disposed) return;
    if (this.observed.status !== "ready") {
      this.reloadRequested = true;
      this.refreshObservation?.();
      return;
    }
    this.applyDocument(this.observed.document);
  }

  dispose(): void {
    this.disposed = true;
    this.reloadRequested = false;
    this.saveSequence += 1;
    this.inFlightSaveSequence = null;
    this.clearAutosave();
    this.disconnectObservations();
    this.listeners.clear();
  }

  suspendAutosave(): () => void {
    const wasScheduled = this.autosave !== null;
    this.clearAutosave();
    let resumed = false;
    return () => {
      if (resumed || this.disposed) return;
      resumed = true;
      if (wasScheduled && this.snapshot.status === "dirty") this.scheduleAutosave();
    };
  }

  private async performWrite(expectedVersion: TVersion): Promise<void> {
    if (this.inFlightSaveSequence !== null) return;
    this.clearAutosave();
    const sequence = ++this.saveSequence;
    this.inFlightSaveSequence = sequence;
    const content = this.snapshot.content;
    const format = this.format;
    this.observedWhileSaving = null;
    this.setSnapshot({ ...this.snapshot, status: "saving", error: null });
    let result: TWriteResult;
    try {
      result = await this.adapter.write({ content, format, expectedVersion });
    } catch (error) {
      if (this.disposed || sequence !== this.saveSequence) return;
      this.inFlightSaveSequence = null;
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.disposed || sequence !== this.saveSequence) return;
    this.inFlightSaveSequence = null;
    const outcome = this.adapter.resolveWrite(result, expectedVersion);
    if (outcome.status === "error") {
      this.setSnapshot({ ...this.snapshot, status: "error", error: outcome.error });
      return;
    }
    if (outcome.status === "conflict") {
      this.observed = { status: "unsettled", version: outcome.version };
      this.enterConflict(outcome.version);
      return;
    }

    const writtenDocument: RevisionedTextDocument<TVersion, TFormat> = {
      content,
      format,
      version: outcome.version,
    };
    const pending = this.takeObservedWhileSaving();
    this.persistedContent = content;
    this.format = format;
    if (pending && !this.observationMatchesWrite(pending, writtenDocument)) {
      const pendingVersion = observationVersion(pending);
      this.observed = pending;
      this.setSnapshot({
        ...this.snapshot,
        status: "conflict",
        modified: this.snapshot.content !== this.persistedContent,
        version: outcome.version,
        observedVersion: pendingVersion,
        error: null,
      });
      return;
    }
    const settledVersion = pending?.status === "ready" ? pending.document.version : outcome.version;
    this.observed = pending ?? { status: "unsettled", version: outcome.version };
    const modified = this.snapshot.content !== this.persistedContent;
    this.setSnapshot({
      ...this.snapshot,
      status: modified ? "dirty" : "clean",
      modified,
      version: settledVersion,
      observedVersion: settledVersion,
      replacedRevision: outcome.replacedRevision,
      error: null,
    });
    if (modified) this.scheduleAutosave();
  }

  private applyDocument(document: RevisionedTextDocument<TVersion, TFormat>): void {
    this.clearAutosave();
    this.saveSequence += 1;
    this.persistedContent = document.content;
    this.format = document.format;
    this.observed = { status: "ready", document };
    this.setSnapshot({
      status: "clean",
      content: document.content,
      lineSeparator: detectLineSeparator(document.content),
      modified: false,
      version: document.version,
      observedVersion: document.version,
      replacedRevision: null,
      error: null,
    });
  }

  private takeObservedWhileSaving(): RevisionedTextObservation<TVersion, TFormat> | null {
    const observation = this.observedWhileSaving;
    this.observedWhileSaving = null;
    return observation;
  }

  private enterConflict(version: TVersion): void {
    this.clearAutosave();
    this.setSnapshot({
      ...this.snapshot,
      status: "conflict",
      modified: this.snapshot.content !== this.persistedContent,
      observedVersion: version,
      error: versionError(this.observed),
    });
  }

  private adoptUnchangedDocument(document: RevisionedTextDocument<TVersion, TFormat>): void {
    this.format = document.format;
    this.observed = { status: "ready", document };
    const modified = this.snapshot.content !== this.persistedContent;
    const recovering = this.snapshot.status === "conflict";
    let status = this.snapshot.status;
    if (recovering) status = modified ? "dirty" : "clean";
    this.setSnapshot({
      ...this.snapshot,
      status,
      modified,
      version: document.version,
      observedVersion: document.version,
      replacedRevision: recovering ? null : this.snapshot.replacedRevision,
      error: recovering ? null : this.snapshot.error,
    });
    if (status === "dirty") this.scheduleAutosave();
    else this.clearAutosave();
  }

  private documentsMatchPersisted(document: RevisionedTextDocument<TVersion, TFormat>): boolean {
    return document.content === this.persistedContent;
  }

  private observationMatchesWrite(
    observation: RevisionedTextObservation<TVersion, TFormat>,
    document: RevisionedTextDocument<TVersion, TFormat>,
  ): boolean {
    return (
      observation.status === "ready" && this.adapter.documentsEqual(observation.document, document)
    );
  }

  private scheduleAutosave(): void {
    this.clearAutosave();
    if (this.inFlightSaveSequence !== null) return;
    this.autosave = this.clock.setTimeout(() => {
      this.autosave = null;
      void this.save();
    }, 800);
  }

  private clearAutosave(): void {
    if (!this.autosave) return;
    this.clock.clearTimeout(this.autosave);
    this.autosave = null;
  }

  private setSnapshot(snapshot: RevisionedTextSnapshot<TVersion, TReplacedRevision>): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export type RevisionedTextConflictCallout =
  | { kind: "changed"; canOverwrite: boolean }
  | { kind: "deleted" }
  | { kind: "checkFailed" };

export function getRevisionedTextConflictCallout<TVersion, TReplacedRevision>(
  snapshot: RevisionedTextSnapshot<TVersion, TReplacedRevision>,
): RevisionedTextConflictCallout | null {
  if (snapshot.status !== "conflict") return null;
  const version = snapshot.observedVersion;
  if (isUnavailableVersion(version)) {
    return version.status === "missing" ? { kind: "deleted" } : { kind: "checkFailed" };
  }
  return { kind: "changed", canOverwrite: snapshot.modified };
}

function observationVersion<TVersion, TFormat>(
  observation: RevisionedTextObservation<TVersion, TFormat>,
): TVersion {
  return observation.status === "ready" ? observation.document.version : observation.version;
}

function versionError<TVersion, TFormat>(
  observation: ObservedState<TVersion, TFormat>,
): string | null {
  return observation.status === "error" ? observation.error : null;
}

function isUnavailableVersion(value: unknown): value is { status: "missing" | "error" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "missing" || value.status === "error")
  );
}

export function detectLineSeparator(content: string): RevisionedTextLineSeparator {
  for (let index = 0; index < content.length; index += 1) {
    const character = content.charCodeAt(index);
    if (character === 10) return "\n";
    if (character === 13) return content.charCodeAt(index + 1) === 10 ? "\r\n" : "\r";
  }
  return "\n";
}
