type Decision = "unknown" | "allowed" | "too-large" | "ambiguous";
interface Entry {
  seen: boolean;
  decision: Decision;
}

/** CDP returns POST data as one value, so only read sizes established by network headers. */
export class RequestBodyPolicy {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly maxBytes = 256 * 1024,
    private readonly waitMs = 100,
  ) {}
  private key(requestId: string, sessionId: string | null): string {
    return JSON.stringify([sessionId, requestId]);
  }
  observe(method: string, params: Record<string, unknown>, sessionId?: string | null): void {
    const requestId = params.requestId;
    if (
      typeof requestId !== "string" ||
      requestId.length > 256 ||
      (sessionId != null && sessionId.length > 256)
    )
      return;
    const key = this.key(requestId, sessionId ?? null);
    if (method === "Network.requestWillBeSent") {
      const previous = this.entries.get(key);
      if (!previous && this.entries.size >= 1024)
        this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { seen: true, decision: previous?.seen ? "ambiguous" : "unknown" });
    } else if (method === "Network.requestWillBeSentExtraInfo") {
      const entry = this.entries.get(key);
      if (!entry?.seen || entry.decision === "ambiguous") return;
      entry.decision = this.classify(params.headers);
    }
  }
  private classify(value: unknown): Decision {
    if (!value || typeof value !== "object") return "unknown";
    const headers = Object.entries(value as Record<string, unknown>);
    const lengths = headers.filter(([key]) => key.toLowerCase() === "content-length");
    if (
      lengths.length !== 1 ||
      headers.some(
        ([key, headerValue]) =>
          key.toLowerCase() === "transfer-encoding" ||
          (key.toLowerCase() === "content-encoding" &&
            String(headerValue).toLowerCase() !== "identity"),
      )
    )
      return "unknown";
    const raw = lengths[0][1];
    if (typeof raw !== "string" && typeof raw !== "number") return "unknown";
    const text = String(raw);
    if (!/^\d{1,15}$/.test(text)) return "unknown";
    const size = Number(text);
    if (!Number.isSafeInteger(size)) return "unknown";
    return size <= this.maxBytes ? "allowed" : "too-large";
  }
  async assertAllowed(requestId: string, sessionId: string | null): Promise<void> {
    const key = this.key(requestId, sessionId);
    if ((this.entries.get(key)?.decision ?? "unknown") === "unknown")
      await new Promise<void>((resolve) => setTimeout(resolve, this.waitMs));
    const decision = this.entries.get(key)?.decision ?? "unknown";
    if (decision === "allowed") return;
    throw new Error(
      decision === "too-large" ? "request-body-too-large" : "request-body-size-unknown",
    );
  }
}
