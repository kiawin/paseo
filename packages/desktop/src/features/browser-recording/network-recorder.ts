export type NetworkBody =
  | { state: "complete" | "truncated"; data: string; encoding: "utf8" | "base64" }
  | { state: "unavailable" | "unsupported" | "none"; reason?: string };

type JsonObject = Record<string, unknown>;
type ExtraKind = "request" | "response";
interface ExtraState {
  requestSeen: boolean;
  responseSeen: boolean;
  expected: boolean;
  baseRequestHeaders: Record<string, string>;
  baseRequestBody: NetworkBody;
  baseLimitations: string[];
  requestExtra?: Record<string, string>;
  responseExtra?: Record<string, string>;
}
interface ExtraWait {
  transaction: NetworkTransaction;
  state: ExtraState;
  done: () => void;
}
interface BodyJob {
  transaction: NetworkTransaction;
  resolve: (body: NetworkBody) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface NetworkTransaction {
  requestId: string;
  sessionId: string | null;
  redirectIndex: number;
  frameId: string | null;
  documentId: string | null;
  frameAttribution: "identified" | "unattributed";
  resourceType: string | null;
  startedAt: number | null;
  wallTime: number | null;
  completedAt: number | null;
  request: { url: string; method: string; headers: Record<string, string>; body: NetworkBody };
  response: null | {
    status: number;
    headers: Record<string, string>;
    body: NetworkBody;
    fromCache: boolean;
    fromServiceWorker: boolean;
    mimeType: string | null;
    bodyOriginalBytes?: number;
    encodedBytes?: number;
  };
  outcome: "complete" | "failed" | "redirected" | "incomplete";
  limitations?: string[];
  // Headers from redirect chains are retained without guessing which hop sent them.
  unattributedExtraHeaders?: Array<{ kind: ExtraKind; headers: Record<string, string> }>;
  error?: string;
  failure?: { canceled?: boolean; blockedReason?: string; corsError?: string };
}
export interface NetworkEvent {
  method: string;
  params: JsonObject;
  sessionId?: string | null;
}
interface Options {
  write: (transaction: NetworkTransaction) => Promise<void>;
  getResponseBody: (
    requestId: string,
    sessionId: string | null,
  ) => Promise<{ body: string; base64Encoded: boolean }>;
  maxBodyBytes?: number;
  maxActiveRequests?: number;
  maxBodyReads?: number;
  maxBodyQueue?: number;
  maxPendingWrites?: number;
  bodyReadTimeoutMs?: number;
  extraInfoTimeoutMs?: number;
  onGap?: (reason: string) => void;
}
const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export class NetworkRecorder {
  // Create one recorder per WebContents. Feed CDP events without awaiting a
  // body read; close() drains writes. Persist onGap/getGaps with the recording.
  private readonly active = new Map<string, NetworkTransaction>();
  private readonly responseExtras = new WeakMap<NetworkTransaction, Record<string, string>>();
  private readonly servedFromCache = new WeakSet<NetworkTransaction>();
  private readonly bodySizes = new WeakMap<NetworkBody, number>();
  private readonly extraStates = new WeakMap<NetworkTransaction, ExtraState>();
  private readonly earlyExtras = new Map<
    string,
    {
      request?: Record<string, string>;
      response?: Record<string, string>;
      ambiguous?: Set<ExtraKind>;
      fromActive?: boolean;
      expiresAt: number;
    }
  >();
  private readonly extraWaiters = new Map<string, ExtraWait[]>();
  private readonly maxBodyBytes: number;
  private readonly maxActiveRequests: number;
  private readonly maxBodyReads: number;
  private readonly maxBodyQueue: number;
  private readonly maxPendingWrites: number;
  private readonly bodyReadTimeoutMs: number;
  private readonly extraInfoTimeoutMs: number;
  private bodyReads = 0;
  private timedOutBodyReads = 0;
  private readonly bodyQueue: BodyJob[] = [];
  private failed = false;
  private pendingWrites = 0;
  private waitingExtras = 0;
  private readonly gaps = new Map<string, number>();
  private readonly failures: unknown[] = [];
  private writes = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  constructor(private readonly options: Options) {
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.maxActiveRequests = options.maxActiveRequests ?? 1024;
    this.maxBodyReads = options.maxBodyReads ?? 16;
    this.maxBodyQueue = options.maxBodyQueue ?? 128;
    this.maxPendingWrites = options.maxPendingWrites ?? 256;
    this.bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? 5000;
    this.extraInfoTimeoutMs = options.extraInfoTimeoutMs ?? 1000;
    for (const limit of [
      this.maxBodyBytes,
      this.maxActiveRequests,
      this.maxBodyReads,
      this.maxBodyQueue,
      this.maxPendingWrites,
      this.bodyReadTimeoutMs,
      this.extraInfoTimeoutMs,
    ]) {
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new Error("Invalid network recorder limit");
    }
  }
  private key(sessionId: string | null, requestId: string): string {
    return JSON.stringify([sessionId, requestId]);
  }
  private limitText(value: string, max: number, transaction: NetworkTransaction): string {
    if (value.length <= max) return value;
    transaction.limitations = [
      ...new Set([...(transaction.limitations ?? []), "metadata-truncated"]),
    ];
    return value.slice(0, max);
  }
  private markLimitation(transaction: NetworkTransaction, reason: string): void {
    transaction.limitations = [...new Set([...(transaction.limitations ?? []), reason])];
  }
  private headers(value: unknown, transaction: NetworkTransaction): Record<string, string> {
    const out = Object.create(null) as Record<string, string>;
    let remaining = 64 * 1024;
    const source = object(value);
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      const entry = source[key];
      if (typeof entry !== "string" && typeof entry !== "number") continue;
      if (remaining <= 0) {
        this.markLimitation(transaction, "metadata-truncated");
        break;
      }
      const name = this.limitText(key, Math.min(remaining, 1024), transaction);
      remaining -= name.length;
      const content = this.limitText(String(entry), remaining, transaction);
      remaining -= content.length;
      if (Object.hasOwn(out, name))
        this.markLimitation(transaction, "metadata-header-name-collision");
      else out[name] = content;
    }
    return out;
  }
  private bounded(data: string, encoding: "utf8" | "base64"): NetworkBody {
    const length = Buffer.byteLength(data, encoding);
    if (length <= this.maxBodyBytes) return { state: "complete", data, encoding };
    const inputLimit =
      encoding === "base64" ? Math.ceil(this.maxBodyBytes / 3) * 4 : this.maxBodyBytes;
    const raw = Buffer.from(data.slice(0, inputLimit), encoding);
    let prefix = raw.subarray(0, this.maxBodyBytes);
    if (encoding === "utf8") {
      // Do not create replacement characters when the byte limit splits UTF-8.
      while (prefix.length) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(prefix);
          break;
        } catch {
          prefix = prefix.subarray(0, -1);
        }
      }
    }
    return { state: "truncated", data: prefix.toString(encoding), encoding };
  }
  private requestEntries(value: unknown): NetworkBody {
    if (!Array.isArray(value) || value.length === 0)
      return { state: "unavailable", reason: "request-body-not-provided" };
    const pieces: Buffer[] = [];
    let remaining = this.maxBodyBytes;
    let truncated = false;
    for (const [index, entry] of value.entries()) {
      if (index >= 4096) {
        truncated = true;
        break;
      }
      const bytes = str(object(entry).bytes);
      if (bytes === null) return { state: "unavailable", reason: "request-body-entry-unavailable" };
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes)) {
        return { state: "unavailable", reason: "request-body-entry-invalid" };
      }
      const size = Buffer.byteLength(bytes, "base64");
      if (size > remaining) truncated = true;
      if (remaining > 0) {
        const prefix = Buffer.from(bytes.slice(0, Math.ceil(remaining / 3) * 4), "base64").subarray(
          0,
          remaining,
        );
        pieces.push(prefix);
        remaining -= prefix.length;
      }
    }
    return {
      state: truncated ? "truncated" : "complete",
      data: Buffer.concat(pieces).toString("base64"),
      encoding: "base64",
    };
  }
  public getGaps(): ReadonlyArray<{ reason: string; count: number }> {
    return Array.from(this.gaps, ([reason, count]) => ({ reason, count }));
  }
  public hasFailed(): boolean {
    return this.failed;
  }
  private gap(reason: string): void {
    this.gaps.set(reason, (this.gaps.get(reason) ?? 0) + 1);
    try {
      this.options.onGap?.(reason);
    } catch (error) {
      this.failed = true;
      if (this.failures.length < 100) this.failures.push(error);
    }
  }
  private pruneEarlyExtras(): void {
    const now = Date.now();
    for (const [key, entry] of this.earlyExtras) {
      if (entry.expiresAt > now) break;
      this.earlyExtras.delete(key);
      this.gap(
        entry.fromActive ? "extra-info-duplicate-or-future-hop" : "extra-info-without-request",
      );
    }
  }
  private applyExtra(transaction: NetworkTransaction, kind: ExtraKind, value: unknown): void {
    const state = this.extraStates.get(transaction)!;
    const captured = this.headers(value, transaction);
    if (kind === "request") {
      state.requestSeen = true;
      state.requestExtra = captured;
      if (transaction.outcome !== "redirected" && transaction.redirectIndex === 0)
        this.requestExtra(transaction, captured);
    } else {
      state.responseSeen = true;
      state.responseExtra = captured;
      if (transaction.outcome !== "redirected" && transaction.redirectIndex === 0)
        this.responseExtra(transaction, captured);
    }
    if (transaction.outcome === "redirected" || transaction.redirectIndex > 0) {
      (transaction.unattributedExtraHeaders ??= []).push({ kind, headers: captured });
    }
  }
  private deliverExtra(key: string, kind: ExtraKind, value: unknown): void {
    const waiter = this.extraWaiters
      .get(key)
      ?.find((entry) =>
        kind === "request" ? !entry.state.requestSeen : !entry.state.responseSeen,
      );
    if (waiter) {
      this.applyExtra(waiter.transaction, kind, value);
      if (waiter.state.requestSeen && waiter.state.responseSeen) waiter.done();
      return;
    }
    const current = this.active.get(key);
    const state = current && this.extraStates.get(current);
    if (current && state && (kind === "request" ? !state.requestSeen : !state.responseSeen)) {
      this.applyExtra(current, kind, value);
      return;
    }
    let early = this.earlyExtras.get(key);
    if (!early) {
      if (this.earlyExtras.size >= this.maxActiveRequests) {
        this.gap("extra-info-buffer-limit");
        return;
      }
      early = {
        expiresAt: Date.now() + this.extraInfoTimeoutMs,
        fromActive: Boolean(current && state),
      };
      this.earlyExtras.set(key, early);
    }
    if (early[kind] || early.ambiguous?.has(kind)) {
      delete early[kind];
      (early.ambiguous ??= new Set()).add(kind);
      this.gap("extra-info-ambiguous");
      return;
    }
    const scratch = { limitations: [] } as unknown as NetworkTransaction;
    early[kind] = this.headers(value, scratch);
    if (scratch.limitations?.length) this.gap("extra-info-metadata-truncated");
  }
  private extraGate(key: string, transaction: NetworkTransaction): Promise<void> {
    const state = this.extraStates.get(transaction)!;
    if (!state.expected || (state.requestSeen && state.responseSeen)) return Promise.resolve();
    if (this.waitingExtras >= this.maxPendingWrites) {
      this.markLimitation(transaction, "extra-info-missing");
      this.gap("extra-info-wait-limit");
      return Promise.resolve();
    }
    this.waitingExtras += 1;
    return new Promise((resolve) => {
      const list = this.extraWaiters.get(key) ?? [];
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      const entry: ExtraWait = {
        transaction,
        state,
        done: () => {
          if (settled) return;
          settled = true;
          this.waitingExtras -= 1;
          clearTimeout(timer);
          const remaining = (this.extraWaiters.get(key) ?? []).filter(
            (candidate) => candidate !== entry,
          );
          if (remaining.length) this.extraWaiters.set(key, remaining);
          else this.extraWaiters.delete(key);
          if (!state.requestSeen || !state.responseSeen)
            this.markLimitation(transaction, "extra-info-missing");
          // eslint-disable-next-line promise/no-multiple-resolved -- done is idempotent across timeout and event paths.
          resolve();
        },
      };
      list.push(entry);
      this.extraWaiters.set(key, list);
      timer = setTimeout(entry.done, this.extraInfoTimeoutMs);
      timer.unref();
    });
  }
  private output(
    transaction: NetworkTransaction,
    body: Promise<NetworkBody> | null = null,
    extraGate: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    if (this.pendingWrites >= this.maxPendingWrites) {
      this.gap("write-backlog-limit");
      return Promise.resolve();
    }
    this.pendingWrites += 1;
    const ready = Promise.all([body ?? Promise.resolve(null), extraGate]).then(([value]) => {
      if (value && transaction.response) {
        transaction.response.body = value;
        const size = this.bodySizes.get(value);
        if (size !== undefined) transaction.response.bodyOriginalBytes = size;
      }
      return transaction;
    });
    const write = this.writes.then(async () => {
      return this.options.write(await ready);
    });
    this.writes = write
      .catch((error) => {
        this.failed = true;
        if (this.failures.length < 100) this.failures.push(error);
        this.gap("write-failed");
      })
      .finally(() => {
        this.pendingWrites -= 1;
      });
    return this.writes;
  }
  private create(
    event: NetworkEvent,
    requestId: string,
    redirectIndex: number,
  ): NetworkTransaction {
    const p = event.params;
    const request = object(p.request);
    let body: NetworkBody = { state: "none" };
    if (typeof request.postData === "string") {
      body = this.bounded(request.postData, "utf8");
      if (Array.isArray(request.postDataEntries)) {
        const entries = this.requestEntries(request.postDataEntries);
        if (
          (entries.state === "complete" || entries.state === "truncated") &&
          Buffer.byteLength(entries.data, "base64") > Buffer.byteLength(request.postData, "utf8")
        )
          body = entries;
      }
    } else if (Array.isArray(request.postDataEntries))
      body = this.requestEntries(request.postDataEntries);
    else if (request.hasPostData === true)
      body = { state: "unavailable", reason: "request-body-not-provided" };
    const transaction: NetworkTransaction = {
      requestId,
      sessionId: event.sessionId ?? null,
      redirectIndex,
      frameId: str(p.frameId),
      documentId: str(p.loaderId),
      frameAttribution: str(p.frameId) && str(p.loaderId) ? "identified" : "unattributed",
      resourceType: str(p.type),
      startedAt: num(p.timestamp),
      wallTime: num(p.wallTime),
      completedAt: null,
      request: {
        url: str(request.url) ?? "",
        method: str(request.method) ?? "",
        headers: {},
        body,
      },
      response: null,
      outcome: "incomplete",
      ...(typeof request.postData === "string" || Array.isArray(request.postDataEntries)
        ? { limitations: ["request-body-completeness-unverified"] }
        : {}),
    };
    transaction.request.url = this.limitText(transaction.request.url, 16 * 1024, transaction);
    transaction.request.method = this.limitText(transaction.request.method, 128, transaction);
    transaction.request.headers = this.headers(request.headers, transaction);
    this.extraStates.set(transaction, {
      requestSeen: false,
      responseSeen: false,
      expected: false,
      baseRequestHeaders: { ...transaction.request.headers },
      baseRequestBody: transaction.request.body,
      baseLimitations: [...(transaction.limitations ?? [])],
    });
    if (transaction.resourceType === "WebSocket")
      transaction.limitations = [
        ...(transaction.limitations ?? []),
        "websocket-frames-unsupported",
      ];
    return transaction;
  }
  private setResponse(transaction: NetworkTransaction, value: unknown): void {
    const response = object(value);
    const rawMime = str(response.mimeType);
    const mimeType = rawMime === null ? null : this.limitText(rawMime, 1024, transaction);
    const streaming =
      transaction.resourceType === "EventSource" ||
      transaction.resourceType === "WebSocket" ||
      mimeType?.toLowerCase().startsWith("text/event-stream");
    transaction.response = {
      status: num(response.status) ?? 0,
      headers: this.headers(response.headers, transaction),
      fromCache:
        response.fromDiskCache === true ||
        response.fromPrefetchCache === true ||
        this.servedFromCache.has(transaction),
      fromServiceWorker: response.fromServiceWorker === true,
      mimeType,
      body: streaming
        ? { state: "unsupported", reason: "streaming-response" }
        : { state: "unavailable", reason: "not-finished" },
    };
  }
  private start(
    event: NetworkEvent,
    id: string,
    key: string,
    previous: NetworkTransaction | undefined,
  ): void {
    let redirectIndex = 0;
    if (previous) {
      this.active.delete(key);
      redirectIndex = previous.redirectIndex + 1;
      if (event.params.redirectResponse) {
        const state = this.extraStates.get(previous)!;
        state.expected = event.params.redirectHasExtraInfo === true;
        previous.request.headers = state.baseRequestHeaders;
        previous.request.body = state.baseRequestBody;
        previous.limitations = [
          ...new Set([
            ...state.baseLimitations,
            ...(previous.limitations?.filter(
              (value) =>
                value === "metadata-truncated" || value === "metadata-header-name-collision",
            ) ?? []),
          ]),
        ];
        if (state.requestExtra)
          (previous.unattributedExtraHeaders ??= []).push({
            kind: "request",
            headers: state.requestExtra,
          });
        if (state.responseExtra)
          (previous.unattributedExtraHeaders ??= []).push({
            kind: "response",
            headers: state.responseExtra,
          });
        this.responseExtras.delete(previous);
        this.setResponse(previous, event.params.redirectResponse);
        if (previous.response)
          previous.response.body = { state: "unavailable", reason: "redirect-body-unavailable" };
        previous.outcome = "redirected";
        previous.limitations = [...(previous.limitations ?? []), "redirect-extra-info-ambiguous"];
      } else {
        previous.outcome = "incomplete";
        previous.error = "request-id-reused";
      }
      previous.completedAt = num(event.params.timestamp);
      void this.output(previous, null, this.extraGate(key, previous));
    } else if (this.active.size >= this.maxActiveRequests) {
      const oldestKey = this.active.keys().next().value as string;
      const oldest = this.active.get(oldestKey)!;
      this.active.delete(oldestKey);
      oldest.outcome = "incomplete";
      oldest.error = "active-request-limit";
      const state = this.extraStates.get(oldest)!;
      if (state.expected && (!state.requestSeen || !state.responseSeen))
        this.markLimitation(oldest, "extra-info-missing");
      void this.output(oldest);
    }
    const next = this.create(event, id, redirectIndex);
    if (redirectIndex)
      next.limitations = [...(next.limitations ?? []), "redirect-extra-info-ambiguous"];
    this.active.set(key, next);
    const early = this.earlyExtras.get(key);
    if (early) {
      this.earlyExtras.delete(key);
      if (early.request) this.applyExtra(next, "request", early.request);
      if (early.response) this.applyExtra(next, "response", early.response);
    }
  }
  private requestExtra(current: NetworkTransaction, value: unknown): void {
    current.request.headers = this.headers(
      { ...current.request.headers, ...this.headers(value, current) },
      current,
    );
    const lengthEntry = Object.entries(current.request.headers).find(
      ([name]) => name.toLowerCase() === "content-length",
    );
    const length = lengthEntry && /^\d+$/.test(lengthEntry[1]) ? Number(lengthEntry[1]) : null;
    const body = current.request.body;
    if (length !== null && body.state === "complete") {
      const captured = Buffer.byteLength(body.data, body.encoding);
      if (captured === length)
        current.limitations = current.limitations?.filter(
          (limitation) => limitation !== "request-body-completeness-unverified",
        );
      else if (captured < length) current.request.body = { ...body, state: "truncated" };
    }
  }
  private responseExtra(current: NetworkTransaction, value: unknown): void {
    const extra = this.headers(value, current);
    if (current.response)
      current.response.headers = this.headers({ ...current.response.headers, ...extra }, current);
    else this.responseExtras.set(current, extra);
  }
  private applyResponse(current: NetworkTransaction, value: unknown): void {
    this.setResponse(current, value);
    const extra = this.responseExtras.get(current);
    if (current.response && extra)
      current.response.headers = this.headers({ ...current.response.headers, ...extra }, current);
    this.responseExtras.delete(current);
  }
  private markCached(current: NetworkTransaction): void {
    this.servedFromCache.add(current);
    if (current.response) current.response.fromCache = true;
  }
  private readBody(transaction: NetworkTransaction): Promise<NetworkBody> {
    if (
      this.bodyQueue.length >= this.maxBodyQueue ||
      (this.bodyReads >= this.maxBodyReads && this.bodyReads === this.timedOutBodyReads)
    ) {
      return Promise.resolve({ state: "unavailable", reason: "body-read-limit" });
    }
    return new Promise((resolve) => {
      const job: BodyJob = {
        transaction,
        resolve,
        timer: setTimeout(() => {
          const index = this.bodyQueue.indexOf(job);
          if (index < 0) return;
          this.bodyQueue.splice(index, 1);
          resolve({ state: "unavailable", reason: "body-read-queue-timeout" });
        }, this.bodyReadTimeoutMs),
      };
      job.timer.unref();
      this.bodyQueue.push(job);
      this.pumpBodyQueue();
    });
  }
  private pumpBodyQueue(): void {
    while (this.bodyReads < this.maxBodyReads && this.bodyQueue.length) {
      const job = this.bodyQueue.shift()!;
      clearTimeout(job.timer);
      this.bodyReads += 1;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.timedOutBodyReads += 1;
        job.resolve({ state: "unavailable", reason: "body-read-timeout" });
        // Electron's debugger command has no cancellation; keep a physical
        // slot until it settles to avoid accumulating unbounded hung calls.
        if (this.timedOutBodyReads === this.bodyReads && this.bodyReads >= this.maxBodyReads) {
          for (const pending of this.bodyQueue.splice(0)) {
            clearTimeout(pending.timer);
            pending.resolve({ state: "unavailable", reason: "body-read-limit" });
          }
        }
      }, this.bodyReadTimeoutMs);
      timer.unref();
      void Promise.resolve()
        .then(() =>
          this.options.getResponseBody(job.transaction.requestId, job.transaction.sessionId),
        )
        .then((body) => {
          const encoding = body.base64Encoded ? "base64" : "utf8";
          const captured = this.bounded(body.body, encoding);
          this.bodySizes.set(captured, Buffer.byteLength(body.body, encoding));
          return captured;
        })
        .catch((): NetworkBody => ({ state: "unavailable", reason: "body-not-available" }))
        .then((body) => {
          clearTimeout(timer);
          this.bodyReads -= 1;
          if (timedOut) this.timedOutBodyReads -= 1;
          else job.resolve(body);
          this.pumpBodyQueue();
          return undefined;
        });
    }
  }
  private async finish(
    current: NetworkTransaction,
    key: string,
    event: NetworkEvent,
  ): Promise<void> {
    this.active.delete(key);
    const extra = this.extraGate(key, current);
    current.completedAt = num(event.params.timestamp);
    if (event.method === "Network.loadingFailed") {
      current.outcome = "failed";
      current.error = this.limitText(
        str(event.params.errorText) ?? "request-failed",
        4096,
        current,
      );
      current.failure = {
        ...(typeof event.params.canceled === "boolean" ? { canceled: event.params.canceled } : {}),
        ...(typeof event.params.blockedReason === "string"
          ? { blockedReason: this.limitText(event.params.blockedReason, 1024, current) }
          : {}),
        ...(typeof object(event.params.corsErrorStatus).corsError === "string"
          ? {
              corsError: this.limitText(
                String(object(event.params.corsErrorStatus).corsError),
                1024,
                current,
              ),
            }
          : {}),
      };
      if (current.response && current.response.body.state !== "unsupported")
        current.response.body = { state: "unavailable", reason: "request-failed" };
      void this.output(current, null, extra);
      return;
    }
    current.outcome = current.response ? "complete" : "incomplete";
    if (!current.response) current.error = "response-not-observed";
    if (event.method === "Network.webSocketClosed") {
      void this.output(current, null, extra);
      return;
    }
    if (this.servedFromCache.has(current) && current.response) current.response.fromCache = true;
    this.servedFromCache.delete(current);
    if (!current.response || current.response.body.state === "unsupported") {
      void this.output(current, null, extra);
      return;
    }
    const encodedBytes = num(event.params.encodedDataLength);
    if (encodedBytes !== null) current.response.encodedBytes = encodedBytes;
    if (encodedBytes !== null && encodedBytes > Math.max(this.maxBodyBytes * 4, 8 * 1024 * 1024)) {
      current.response.body = { state: "unavailable", reason: "body-too-large" };
      void this.output(current, null, extra);
      return;
    }
    if (this.pendingWrites >= this.maxPendingWrites) {
      void this.output(current, null, extra);
      return;
    }
    void this.output(current, this.readBody(current), extra);
  }
  async handle(event: NetworkEvent): Promise<void> {
    if (this.closed) return;
    this.pruneEarlyExtras();
    if (this.handleTargetEvent(event)) return;
    const id = str(event.params.requestId);
    if (!id) return;
    const sessionId = event.sessionId ?? null;
    const key = this.key(sessionId, id);
    const current = this.active.get(key);
    const extraKind = this.getExtraKind(event.method);
    if (extraKind) {
      this.deliverExtra(key, extraKind, event.params.headers);
      return;
    }
    if (event.method === "Network.webSocketCreated") {
      this.gap("websocket-traffic-unsupported");
      this.start(
        {
          method: "Network.requestWillBeSent",
          sessionId,
          params: {
            requestId: id,
            type: "WebSocket",
            frameId: event.params.frameId ?? object(event.params.initiator).frameId,
            loaderId: event.params.loaderId ?? object(event.params.initiator).loaderId,
            request: { url: event.params.url, method: "GET", headers: {} },
          },
        },
        id,
        key,
        current,
      );
      return;
    }
    if (event.method === "Network.requestWillBeSent") {
      this.start(event, id, key, current);
      return;
    }
    if (!current) {
      if (
        ["Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(
          event.method,
        )
      )
        this.gap("event-without-request");
      return;
    }
    switch (event.method) {
      case "Network.responseReceived":
        this.extraStates.get(current)!.expected = event.params.hasExtraInfo === true;
        this.applyResponse(current, event.params.response);
        break;
      case "Network.requestServedFromCache":
        this.markCached(current);
        break;
      case "Network.webSocketWillSendHandshakeRequest":
        current.request.headers = this.headers(object(event.params.request).headers, current);
        break;
      case "Network.webSocketHandshakeResponseReceived":
        this.setResponse(current, event.params.response);
        break;
      case "Network.webSocketClosed":
      case "Network.loadingFailed":
      case "Network.loadingFinished":
        await this.finish(current, key, event);
        break;
    }
  }
  private getExtraKind(method: string): ExtraKind | null {
    if (method === "Network.requestWillBeSentExtraInfo") return "request";
    if (method === "Network.responseReceivedExtraInfo") return "response";
    return null;
  }
  private handleTargetEvent(event: NetworkEvent): boolean {
    if (event.method !== "Target.detachedFromTarget" || typeof event.params.sessionId !== "string")
      return false;
    this.detachSession(event.params.sessionId);
    return true;
  }
  private detachSession(sessionId: string): void {
    for (const entries of Array.from(this.extraWaiters.values())) {
      for (const entry of entries) {
        if (entry.transaction.sessionId === sessionId) entry.done();
      }
    }
    for (const [key, transaction] of this.active) {
      if (transaction.sessionId !== sessionId) continue;
      this.active.delete(key);
      transaction.outcome = "incomplete";
      transaction.error = "session-detached";
      const state = this.extraStates.get(transaction)!;
      if (state.expected && (!state.requestSeen || !state.responseSeen))
        this.markLimitation(transaction, "extra-info-missing");
      void this.output(transaction);
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const entries of Array.from(this.extraWaiters.values()))
      for (const entry of entries) entry.done();
    for (const entry of this.earlyExtras.values())
      this.gap(
        entry.fromActive ? "extra-info-duplicate-or-future-hop" : "extra-info-without-request",
      );
    this.earlyExtras.clear();
    for (const transaction of this.active.values()) {
      transaction.outcome = "incomplete";
      transaction.error = "recording-stopped";
      const state = this.extraStates.get(transaction)!;
      if (state.expected && (!state.requestSeen || !state.responseSeen))
        transaction.limitations = [...(transaction.limitations ?? []), "extra-info-missing"];
      void this.output(transaction);
    }
    this.active.clear();
    this.closePromise = this.writes.then(() => {
      if (this.failures.length)
        throw new AggregateError(this.failures, "Network recording writes failed");
      return undefined;
    });
    return this.closePromise;
  }
}
