import { describe, expect, it, vi } from "vitest";
import * as sharedCdp from "../browser-automation/cdp-session-queue.js";
import fixture from "./network-fixture.json";

interface Event {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string | null;
}
interface Transaction {
  requestId: string;
  sessionId: string | null;
  redirectIndex: number;
  frameId: string | null;
  documentId: string | null;
  resourceType: string | null;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: { state: string; data?: string; encoding?: string };
  };
  response: null | {
    status: number;
    headers: Record<string, string>;
    body: { state: string; data?: string; encoding?: string };
    fromCache: boolean;
  };
  outcome: string;
  error?: string;
}
interface Recorder {
  handle(event: Event): Promise<void>;
  close(): Promise<void>;
}
type RecorderFactory = new (options: {
  write: (transaction: Transaction) => Promise<void>;
  getResponseBody: (
    requestId: string,
    sessionId: string | null,
  ) => Promise<{ body: string; base64Encoded: boolean }>;
  maxBodyBytes?: number;
  maxActiveRequests?: number;
  maxPendingWrites?: number;
  maxBodyReads?: number;
  maxBodyQueue?: number;
  bodyReadTimeoutMs?: number;
  extraInfoTimeoutMs?: number;
  onGap?: (reason: string) => void;
}) => Recorder;
const { NetworkRecorder } = sharedCdp as typeof sharedCdp & { NetworkRecorder: RecorderFactory };
const request = (id: string, url: string, extra: Record<string, unknown> = {}): Event => ({
  method: "Network.requestWillBeSent",
  params: {
    requestId: id,
    frameId: "frame",
    loaderId: "document",
    type: "Fetch",
    timestamp: 1,
    request: { url, method: "GET", headers: {} },
    ...extra,
  },
});
const response = (id: string, extra: Record<string, unknown> = {}): Event => ({
  method: "Network.responseReceived",
  params: { requestId: id, response: { status: 200, headers: {}, ...extra } },
});
const finished = (id: string): Event => ({
  method: "Network.loadingFinished",
  params: { requestId: id, timestamp: 2 },
});
function setup(overrides: Partial<ConstructorParameters<RecorderFactory>[0]> = {}) {
  const transactions: Transaction[] = [];
  const body = vi.fn(async () => ({ body: "ok", base64Encoded: false }));
  const recorder = new NetworkRecorder({
    write: async (value) => {
      transactions.push(value);
    },
    getResponseBody: body,
    ...overrides,
  });
  return { recorder, transactions, body };
}

describe("network transaction reconstruction", () => {
  it("reconstructs the captured Electron POST, including extra headers and body", async () => {
    const { recorder, transactions } = setup({ getResponseBody: async () => fixture.body });
    for (const event of fixture.events) await recorder.handle(event);
    await recorder.close();
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      requestId: fixture.events[0].params.requestId,
      frameId: fixture.events[0].params.frameId,
      documentId: fixture.events[0].params.loaderId,
      resourceType: "Fetch",
      outcome: "complete",
      request: {
        method: "POST",
        body: { state: "complete", data: "probe-body", encoding: "utf8" },
      },
      response: {
        status: 200,
        body: { state: "complete", data: fixture.body.body, encoding: "utf8" },
      },
    });
    expect(transactions[0].limitations ?? []).not.toContain("request-body-completeness-unverified");
    expect(transactions[0].request.headers).toHaveProperty("Content-Length", "10");
    expect(transactions[0].response?.headers).toHaveProperty("Content-Length", "40");
    expect(Object.keys(transactions[0].request.headers).length).toBeGreaterThan(0);
    expect(Object.keys(transactions[0].response!.headers).length).toBeGreaterThan(0);
  });

  it("retains redirect hops, failed requests and cache state with isolated child sessions", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle({ ...request("r", "https://fixture.test/start"), sessionId: "child-a" });
    await recorder.handle({
      ...request("r", "https://fixture.test/end", {
        redirectResponse: { status: 302, headers: { location: "/end" } },
        type: "Document",
      }),
      sessionId: "child-a",
    });
    await recorder.handle({
      ...response("r", { status: 200, fromDiskCache: true }),
      sessionId: "child-a",
    });
    await recorder.handle({ ...finished("r"), sessionId: "child-a" });
    await recorder.handle({ ...request("r", "https://fixture.test/fail"), sessionId: "child-b" });
    await recorder.handle({
      method: "Network.loadingFailed",
      sessionId: "child-b",
      params: { requestId: "r", errorText: "net::ERR_FAILED", timestamp: 3 },
    });
    await recorder.close();
    expect(transactions).toHaveLength(3);
    expect(transactions[0]).toMatchObject({
      sessionId: "child-a",
      redirectIndex: 0,
      outcome: "redirected",
      response: { status: 302, body: { state: "unavailable" } },
    });
    expect(transactions[1]).toMatchObject({
      sessionId: "child-a",
      redirectIndex: 1,
      outcome: "complete",
      response: { status: 200, fromCache: true },
    });
    expect(transactions[2]).toMatchObject({
      sessionId: "child-b",
      outcome: "failed",
      error: "net::ERR_FAILED",
    });
  });

  it("labels unavailable and truncated binary bodies without losing transaction metadata", async () => {
    const getResponseBody = vi
      .fn()
      .mockRejectedValueOnce(new Error("evicted"))
      .mockResolvedValueOnce({
        body: Buffer.from([0, 1, 2, 3, 4]).toString("base64"),
        base64Encoded: true,
      });
    const { recorder, transactions } = setup({ getResponseBody, maxBodyBytes: 3 });
    for (const id of ["missing", "binary"]) {
      await recorder.handle(request(id, `https://fixture.test/${id}`));
      await recorder.handle(response(id));
      await recorder.handle(finished(id));
    }
    await recorder.close();
    expect(transactions[0].response?.body).toMatchObject({ state: "unavailable" });
    expect(transactions[1].response?.body).toEqual({
      state: "truncated",
      data: Buffer.from([0, 1, 2]).toString("base64"),
      encoding: "base64",
    });
  });

  it("makes bounded-buffer eviction, live streams and interrupted requests explicit", async () => {
    const { recorder, transactions } = setup({ maxActiveRequests: 1 });
    await recorder.handle(request("old", "https://fixture.test/old"));
    await recorder.handle(request("new", "https://fixture.test/new", { type: "EventSource" }));
    await recorder.handle(response("new", { mimeType: "text/event-stream" }));
    await recorder.close();
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      requestId: "old",
      outcome: "incomplete",
      error: "active-request-limit",
    });
    expect(transactions[1]).toMatchObject({
      requestId: "new",
      outcome: "incomplete",
      response: { body: { state: "unsupported" } },
    });
  });
  it("does not attach late redirect extra headers to the next hop", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle(request("r", "https://fixture.test/first"));
    await recorder.handle(
      request("r", "https://fixture.test/second", {
        redirectResponse: { status: 302, headers: {} },
      }),
    );
    await recorder.handle({
      method: "Network.responseReceivedExtraInfo",
      params: { requestId: "r", headers: { "set-cookie": "first-hop-only" } },
    });
    await recorder.handle(response("r"));
    await recorder.handle(finished("r"));
    await recorder.close();
    expect(transactions[1].response?.headers).not.toHaveProperty("set-cookie");
    expect(transactions[1]).toMatchObject({ limitations: ["redirect-extra-info-ambiguous"] });
  });

  it("exposes missing response events and propagates storage failures on close", async () => {
    const writes = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValue(undefined);
    const recorder = new NetworkRecorder({
      write: writes,
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
    });
    await recorder.handle(request("one", "https://fixture.test/one"));
    await recorder.handle(finished("one"));
    await recorder.handle(request("two", "https://fixture.test/two"));
    await recorder.handle(finished("two"));
    await expect(recorder.close()).rejects.toThrow("Network recording writes failed");
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes.mock.calls[0][0]).toMatchObject({
      outcome: "incomplete",
      error: "response-not-observed",
    });
  });

  it("reports orphan events and unsupported websocket traffic as gaps", async () => {
    const { recorder } = setup();
    await recorder.handle({ method: "Network.loadingFinished", params: { requestId: "unknown" } });
    await recorder.handle({
      method: "Network.webSocketCreated",
      params: { requestId: "socket", url: "wss://fixture.test" },
    });
    await recorder.close();
    expect((recorder as Recorder & { getGaps(): unknown }).getGaps()).toEqual([
      { reason: "event-without-request", count: 1 },
      { reason: "websocket-traffic-unsupported", count: 1 },
    ]);
  });
  it("bounds queued writes and reports dropped records", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { recorder, body } = setup({ maxPendingWrites: 1, write: () => pending });
    await recorder.handle(request("one", "https://fixture.test/one"));
    const first = recorder.handle(finished("one"));
    await recorder.handle(request("two", "https://fixture.test/two"));
    await recorder.handle(response("two"));
    await recorder.handle(finished("two"));
    expect(body).not.toHaveBeenCalled();
    expect((recorder as Recorder & { getGaps(): unknown }).getGaps()).toEqual([
      { reason: "write-backlog-limit", count: 1 },
    ]);
    finish();
    await first;
    await recorder.close();
  });
  it("times out body reads and limits unresolved body retrievals", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<{ body: string; base64Encoded: boolean }>(() => {});
      const { recorder, transactions } = setup({
        maxBodyReads: 1,
        bodyReadTimeoutMs: 10,
        getResponseBody: () => never,
      });
      await recorder.handle(request("one", "https://fixture.test/one"));
      await recorder.handle(response("one"));
      const first = recorder.handle(finished("one"));
      expect(transactions).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(30);
      await first;
      await recorder.handle(request("two", "https://fixture.test/two"));
      await recorder.handle(response("two"));
      await recorder.handle(finished("two"));
      await recorder.close();
      expect(transactions[0].response?.body).toMatchObject({
        state: "unavailable",
        reason: "body-read-timeout",
      });
      expect(transactions[1].response?.body).toMatchObject({
        state: "unavailable",
        reason: "body-read-limit",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("records the WebSocket endpoint and handshake while disclosing unsupported frames", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle({
      method: "Network.webSocketCreated",
      params: { requestId: "ws", url: "wss://fixture.test/socket" },
    });
    await recorder.handle({
      method: "Network.webSocketWillSendHandshakeRequest",
      params: { requestId: "ws", request: { headers: { Origin: "https://fixture.test" } } },
    });
    await recorder.handle({
      method: "Network.webSocketHandshakeResponseReceived",
      params: { requestId: "ws", response: { status: 101, headers: {} } },
    });
    await recorder.handle({
      method: "Network.webSocketClosed",
      params: { requestId: "ws", timestamp: 5 },
    });
    await recorder.close();
    expect(transactions[0]).toMatchObject({
      resourceType: "WebSocket",
      request: { url: "wss://fixture.test/socket", headers: { Origin: "https://fixture.test" } },
      response: { status: 101, body: { state: "unsupported" } },
      limitations: ["websocket-frames-unsupported"],
    });
  });
  it("bounds retained headers and URLs and marks truncated metadata", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle(
      request("large", "https://fixture.test/" + "x".repeat(30000), {
        request: {
          url: "https://fixture.test/" + "x".repeat(30000),
          method: "GET",
          headers: { "x-large": "a".repeat(200000) },
        },
      }),
    );
    await recorder.handle(finished("large"));
    await recorder.close();
    expect(transactions[0].request.url.length).toBeLessThanOrEqual(16384);
    expect(transactions[0].request.headers["x-large"].length).toBeLessThanOrEqual(65536);
    expect(transactions[0]).toMatchObject({ limitations: ["metadata-truncated"] });
  });
  it("matches extra headers arriving before a request and after completion", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "late", headers: { Cookie: "synthetic-session" } },
    });
    await recorder.handle(request("late", "https://fixture.test/late"));
    await recorder.handle({
      ...response("late"),
      params: { ...response("late").params, hasExtraInfo: true },
    });
    await recorder.handle(finished("late"));
    await recorder.handle({
      method: "Network.responseReceivedExtraInfo",
      params: { requestId: "late", headers: { "set-cookie": "synthetic-result" } },
    });
    await recorder.close();
    expect(transactions[0].request.headers).toHaveProperty("Cookie", "synthetic-session");
    expect(transactions[0].response?.headers).toHaveProperty("set-cookie", "synthetic-result");
    expect(transactions[0].limitations ?? []).not.toContain("extra-info-missing");
  });
  it("marks promised extra headers missing after a bounded wait", async () => {
    vi.useFakeTimers();
    try {
      const { recorder, transactions } = setup({ extraInfoTimeoutMs: 50 });
      await recorder.handle(request("missing-extra", "https://fixture.test/missing"));
      await recorder.handle({
        ...response("missing-extra"),
        params: { ...response("missing-extra").params, hasExtraInfo: true },
      });
      await recorder.handle(finished("missing-extra"));
      await vi.advanceTimersByTimeAsync(51);
      await recorder.close();
      expect(transactions[0].limitations).toContain("extra-info-missing");
    } finally {
      vi.useRealTimers();
    }
  });
  it("signals sink failure as soon as the write fails", async () => {
    const onGap = vi.fn();
    const recorder = new NetworkRecorder({
      write: async () => {
        throw new Error("disk failed");
      },
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
      onGap,
    });
    await recorder.handle(request("disk", "https://fixture.test/disk"));
    await recorder.handle(finished("disk"));
    await vi.waitFor(() => expect(onGap).toHaveBeenCalledWith("write-failed"));
    expect((recorder as Recorder & { hasFailed(): boolean }).hasFailed()).toBe(true);
    await expect(recorder.close()).rejects.toThrow("Network recording writes failed");
  });
  it("captures binary request entries and distinguishes service worker responses from cache", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle(
      request("binary-post", "https://fixture.test/upload", {
        request: {
          url: "https://fixture.test/upload",
          method: "POST",
          headers: {},
          hasPostData: true,
          postDataEntries: [{ bytes: "AAE=" }, { bytes: "AgM=" }],
        },
      }),
    );
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "binary-post", headers: { "Content-Length": "4" } },
    });
    await recorder.handle(response("binary-post", { fromServiceWorker: true }));
    await recorder.handle(finished("binary-post"));
    await recorder.close();
    expect(transactions[0].request.body).toEqual({
      state: "complete",
      data: "AAECAw==",
      encoding: "base64",
    });
    expect(transactions[0].response).toMatchObject({ fromCache: false, fromServiceWorker: true });
    expect(transactions[0].limitations ?? []).not.toContain("request-body-completeness-unverified");
  });
  it("matches response extra before the request and request extra after completion", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle({
      method: "Network.responseReceivedExtraInfo",
      params: { requestId: "reordered", headers: { "set-cookie": "pre-request" } },
    });
    await recorder.handle(request("reordered", "https://fixture.test/reordered"));
    await recorder.handle({
      ...response("reordered"),
      params: { ...response("reordered").params, hasExtraInfo: true },
    });
    await recorder.handle(finished("reordered"));
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "reordered", headers: { Cookie: "post-finish" } },
    });
    await recorder.close();
    expect(transactions[0].request.headers).toHaveProperty("Cookie", "post-finish");
    expect(transactions[0].response?.headers).toHaveProperty("set-cookie", "pre-request");
    expect(transactions[0].limitations ?? []).not.toContain("extra-info-missing");
  });
  it("does not assign ambiguous pre-redirect extra headers to the wrong hop", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle(request("chain", "https://fixture.test/first"));
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "chain", headers: { Cookie: "uncertain-hop" } },
    });
    await recorder.handle(
      request("chain", "https://fixture.test/second", {
        redirectResponse: { status: 302, headers: {} },
        redirectHasExtraInfo: false,
      }),
    );
    await recorder.handle(response("chain"));
    await recorder.handle(finished("chain"));
    await recorder.close();
    expect(transactions[0].request.headers).not.toHaveProperty("Cookie");
    expect(transactions[0]).toMatchObject({
      unattributedExtraHeaders: [{ kind: "request", headers: { Cookie: "uncertain-hop" } }],
    });
    expect(transactions[0].limitations).toContain("redirect-extra-info-ambiguous");
    expect(transactions[1].request.headers).not.toHaveProperty("Cookie");
  });
  it("marks a request body truncated when the sent length exceeds the captured text", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle(
      request("post", "https://fixture.test/post", {
        request: { url: "https://fixture.test/post", method: "POST", headers: {}, postData: "abc" },
      }),
    );
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "post", headers: { "Content-Length": "9" } },
    });
    await recorder.handle(response("post"));
    await recorder.handle(finished("post"));
    await recorder.close();
    expect(transactions[0].request.body).toMatchObject({ state: "truncated", data: "abc" });
  });
  it("waits for in-flight body retrieval before close resolves", async () => {
    let resolveBody!: (value: { body: string; base64Encoded: boolean }) => void;
    const pending = new Promise<{ body: string; base64Encoded: boolean }>((resolve) => {
      resolveBody = resolve;
    });
    const { recorder, transactions } = setup({ getResponseBody: () => pending });
    await recorder.handle(request("pending", "https://fixture.test/pending"));
    await recorder.handle(response("pending"));
    await recorder.handle(finished("pending"));
    let closed = false;
    const closing = recorder.close().then(() => {
      closed = true;
      return undefined;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolveBody({ body: "eventual", base64Encoded: false });
    await closing;
    expect(transactions[0].response?.body).toMatchObject({ state: "complete", data: "eventual" });
  });
  it("reports each storage failure while retaining the failed state", async () => {
    const onGap = vi.fn();
    const recorder = new NetworkRecorder({
      write: async () => {
        throw new Error("disk failed");
      },
      getResponseBody: async () => ({ body: "", base64Encoded: false }),
      onGap,
    });
    for (const id of ["a", "b"]) {
      await recorder.handle(request(id, `https://fixture.test/${id}`));
      await recorder.handle(finished(id));
    }
    await expect(recorder.close()).rejects.toThrow("Network recording writes failed");
    expect(onGap).toHaveBeenCalledTimes(2);
    expect((recorder as Recorder & { hasFailed(): boolean }).hasFailed()).toBe(true);
  });
  it("queues a burst of forty completed responses without losing bodies", async () => {
    const { recorder, transactions, body } = setup({ maxBodyReads: 4, maxBodyQueue: 64 });
    for (let index = 0; index < 40; index++) {
      const id = `burst-${index}`;
      void recorder.handle(request(id, `https://fixture.test/${id}`));
      void recorder.handle(response(id));
      void recorder.handle(finished(id));
    }
    await recorder.close();
    expect(body).toHaveBeenCalledTimes(40);
    expect(transactions).toHaveLength(40);
    expect(
      transactions.every((transaction) => transaction.response?.body.state === "complete"),
    ).toBe(true);
  });
  it("records wall time, memory-cache hits and a detached child session", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle({
      ...request("cached", "https://fixture.test/cached", { wallTime: 1234.5 }),
      sessionId: "child",
    });
    await recorder.handle({
      method: "Network.requestServedFromCache",
      sessionId: "child",
      params: { requestId: "cached" },
    });
    await recorder.handle({ ...response("cached"), sessionId: "child" });
    await recorder.handle({ ...finished("cached"), sessionId: "child" });
    await recorder.handle({ ...request("open", "https://fixture.test/open"), sessionId: "child" });
    await recorder.handle({ method: "Target.detachedFromTarget", params: { sessionId: "child" } });
    await recorder.close();
    expect(transactions[0]).toMatchObject({ wallTime: 1234.5, response: { fromCache: true } });
    expect(transactions[1]).toMatchObject({
      requestId: "open",
      outcome: "incomplete",
      error: "session-detached",
    });
  });
  it("flags duplicate or future-hop extra information without assigning it to the current request", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle(request("dup", "https://fixture.test/dup"));
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "dup", headers: { Cookie: "first" } },
    });
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "dup", headers: { Cookie: "second" } },
    });
    await recorder.handle(response("dup"));
    await recorder.handle(finished("dup"));
    await recorder.close();
    expect(transactions[0].request.headers.Cookie).toBe("first");
    expect(
      (recorder as Recorder & { getGaps(): Array<{ reason: string }> }).getGaps(),
    ).toContainEqual(expect.objectContaining({ reason: "extra-info-duplicate-or-future-hop" }));
  });
  it("resumes body capture after a previously timed-out debugger call settles", async () => {
    vi.useFakeTimers();
    try {
      let settle!: (value: { body: string; base64Encoded: boolean }) => void;
      const stalled = new Promise<{ body: string; base64Encoded: boolean }>((resolve) => {
        settle = resolve;
      });
      const body = vi
        .fn()
        .mockReturnValueOnce(stalled)
        .mockResolvedValue({ body: "recovered", base64Encoded: false });
      const { recorder, transactions } = setup({
        maxBodyReads: 1,
        bodyReadTimeoutMs: 10,
        getResponseBody: body,
      });
      await recorder.handle(request("stalled", "https://fixture.test/stalled"));
      await recorder.handle(response("stalled"));
      await recorder.handle(finished("stalled"));
      await vi.advanceTimersByTimeAsync(11);
      settle({ body: "late", base64Encoded: false });
      await vi.advanceTimersByTimeAsync(0);
      await recorder.handle(request("recovered", "https://fixture.test/recovered"));
      await recorder.handle(response("recovered"));
      await recorder.handle(finished("recovered"));
      await recorder.close();
      expect(transactions[0].response?.body).toMatchObject({
        state: "unavailable",
        reason: "body-read-timeout",
      });
      expect(transactions[1].response?.body).toMatchObject({
        state: "complete",
        data: "recovered",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not report a duplicate gap when early redirect extra headers are consumed", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle(request("future", "https://fixture.test/start"));
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "future", headers: { Cookie: "one" } },
    });
    await recorder.handle({
      method: "Network.requestWillBeSentExtraInfo",
      params: { requestId: "future", headers: { Cookie: "two" } },
    });
    await recorder.handle(
      request("future", "https://fixture.test/end", {
        redirectResponse: { status: 302, headers: {} },
      }),
    );
    await recorder.handle(response("future"));
    await recorder.handle(finished("future"));
    await recorder.close();
    expect(
      (recorder as Recorder & { getGaps(): Array<{ reason: string }> }).getGaps(),
    ).not.toContainEqual(expect.objectContaining({ reason: "extra-info-duplicate-or-future-hop" }));
    expect(transactions[1]).toMatchObject({
      unattributedExtraHeaders: [{ kind: "request", headers: { Cookie: "two" } }],
    });
  });
  it("does not fetch an obviously oversized response body", async () => {
    const { recorder, transactions, body } = setup();
    await recorder.handle(request("large-response", "https://fixture.test/large"));
    await recorder.handle(response("large-response"));
    await recorder.handle({
      method: "Network.loadingFinished",
      params: { requestId: "large-response", encodedDataLength: 10000000 },
    });
    await recorder.close();
    expect(body).not.toHaveBeenCalled();
    expect(transactions[0].response?.body).toMatchObject({
      state: "unavailable",
      reason: "body-too-large",
    });
  });
  it("marks body reads unavailable when the bounded queue fills", async () => {
    let finish!: (value: { body: string; base64Encoded: boolean }) => void;
    const pending = new Promise<{ body: string; base64Encoded: boolean }>((resolve) => {
      finish = resolve;
    });
    const getResponseBody = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ body: "second", base64Encoded: false });
    const { recorder, transactions } = setup({ maxBodyReads: 1, maxBodyQueue: 1, getResponseBody });
    for (const id of ["a", "b", "c"]) {
      await recorder.handle(request(id, `https://fixture.test/${id}`));
      await recorder.handle(response(id));
      await recorder.handle(finished(id));
    }
    finish({ body: "first", base64Encoded: false });
    await recorder.close();
    expect(transactions[2].response?.body).toMatchObject({
      state: "unavailable",
      reason: "body-read-limit",
    });
    expect(getResponseBody).toHaveBeenCalledTimes(2);
  });
  it("retains cancellation and browser security failure details", async () => {
    const { recorder, transactions } = setup();
    await recorder.handle(request("blocked", "https://fixture.test/blocked"));
    await recorder.handle({
      method: "Network.loadingFailed",
      params: {
        requestId: "blocked",
        errorText: "blocked",
        canceled: true,
        blockedReason: "csp",
        corsErrorStatus: { corsError: "DisallowedByMode" },
      },
    });
    await recorder.close();
    expect(transactions[0]).toMatchObject({
      outcome: "failed",
      failure: { canceled: true, blockedReason: "csp", corsError: "DisallowedByMode" },
    });
  });
});
