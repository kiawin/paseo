import { isDeepStrictEqual } from "node:util";

export type CdpCommandSender = (
  command: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export class CdpSessionQueue {
  private readonly interactive: Array<() => void> = [];
  private readonly background: Array<() => void> = [];
  private running = false;

  public run<T>(
    task: () => Promise<T>,
    priority: "interactive" | "background" = "interactive",
  ): Promise<T> {
    if (priority === "background" && this.background.length >= 64)
      return Promise.reject(new Error("CDP background queue limit reached"));
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.running = false;
            this.pump();
          });
      };
      (priority === "background" ? this.background : this.interactive).push(start);
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    const next = this.interactive.shift() ?? this.background.shift();
    if (!next) return;
    this.running = true;
    next();
  }
}

export interface CdpDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  on?(
    event: "message",
    listener: (
      event: unknown,
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => void,
  ): void;
  on?(event: "detach", listener: (event?: unknown, reason?: string) => void): void;
  removeListener?(
    event: "message",
    listener: (
      event: unknown,
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => void,
  ): void;
  removeListener?(event: "detach", listener: (event?: unknown, reason?: string) => void): void;
}

export interface CdpMessage {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpConsumerCallbacks {
  // Messages are broadcast to every live consumer; filter by sessionId when
  // handling one child target. A detach is a capture gap until recover succeeds.
  onMessage?: (message: CdpMessage) => void;
  onDetach?: (reason?: string) => void;
}

interface DomainState {
  kind: "domain" | "autoAttach";
  domain: string;
  sessionId?: string;
  params: Record<string, unknown>;
  owners: Set<CdpConsumer>;
  enabled: boolean;
}

export class CdpConsumer {
  public closed = false;
  public readonly domains = new Set<string>();
  private releasePromise: Promise<void> | null = null;

  public constructor(
    private readonly session: SharedCdpSession,
    public readonly callbacks: CdpConsumerCallbacks,
  ) {}

  public enableDomain(
    domain: string,
    sessionId?: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    // Concurrent owners must request identical settings until all release the domain.
    return this.session.enableDomain(this, domain, sessionId, params);
  }

  public enableAutoAttach(sessionId?: string): Promise<void> {
    return this.session.enableAutoAttach(this, sessionId);
  }

  public recover(): Promise<void> {
    return this.session.recover(this);
  }

  public sendCommand(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("CDP consumer is closed"));
    // Domain and auto-attach ownership must go through the shared methods.
    // The browser coordinator owns any explicit target attachment or detachment.
    if (
      /^[A-Za-z][A-Za-z0-9]*\.(enable|disable)$/.test(command) ||
      command === "Target.setAutoAttach"
    ) {
      return Promise.reject(
        new Error("Use CDP ownership methods for domain or auto-attach changes"),
      );
    }
    return this.session.sendConsumerCommand(this, command, params, sessionId);
  }

  public sendBackgroundCommand(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("CDP consumer is closed"));
    if (!/^Network\.(getResponseBody|getRequestPostData)$/.test(command))
      return Promise.reject(new Error("Unsupported background CDP command"));
    return this.session.sendConsumerBackgroundCommand(this, command, params, sessionId);
  }

  public release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.closed = true;
    this.releasePromise = this.session.release(this);
    return this.releasePromise;
  }
}

export class SharedCdpSession {
  private readonly queue = new CdpSessionQueue();
  private readonly consumers = new Set<CdpConsumer>();
  private readonly domains = new Map<string, DomainState>();
  private readonly runtimeContexts = new Map<string, CdpMessage>();
  private runtimeContextsDropped = 0;
  private disposed = false;
  private attached = false;
  private generation = 0;

  private readonly onMessage = (
    _event: unknown,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => {
    if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
      // Child target sessions cannot be recovered by their former IDs. Every
      // consumer receives this event and must attach and enable the new target.
      this.forgetChildSession(params.sessionId);
    }
    const message: CdpMessage = {
      method,
      params: params ?? {},
      ...(sessionId ? { sessionId } : {}),
    };
    this.trackRuntimeContext(message);
    for (const consumer of this.consumers) {
      if (!consumer.closed) {
        try {
          consumer.callbacks.onMessage?.(message);
        } catch (error) {
          console.warn("[browser-automation] CDP message consumer failed", {
            errorType: error instanceof Error ? error.name : typeof error,
          });
        }
      }
    }
  };

  private readonly onDetach = (_event?: unknown, reason?: string) => {
    if (!this.attached) {
      this.runtimeContexts.clear();
      this.runtimeContextsDropped = 0;
      return;
    }
    this.attached = false;
    this.generation += 1;
    this.runtimeContexts.clear();
    this.runtimeContextsDropped = 0;
    for (const [key, state] of this.domains) {
      state.enabled = false;
      // Child CDP session IDs die with the debugger attachment. Consumers
      // receive the detach event and must attach new child targets themselves.
      if (state.sessionId) this.forgetState(key, state);
    }
    for (const consumer of this.consumers) {
      if (!consumer.closed) {
        try {
          consumer.callbacks.onDetach?.(reason);
        } catch (error) {
          console.warn("[browser-automation] CDP detach consumer failed", {
            errorType: error instanceof Error ? error.name : typeof error,
          });
        }
      }
    }
  };

  public constructor(private readonly debuggerClient: CdpDebugger) {
    debuggerClient.on?.("message", this.onMessage);
    debuggerClient.on?.("detach", this.onDetach);
  }

  public createConsumer(callbacks: CdpConsumerCallbacks): CdpConsumer {
    if (this.disposed) throw new Error("CDP session is disposed");
    const consumer = new CdpConsumer(this, callbacks);
    this.consumers.add(consumer);
    return consumer;
  }

  // Runtime.enable is shared. A later consumer must be able to discover the
  // contexts emitted when another consumer enabled it first.
  public runtimeContextSnapshot(): { contexts: CdpMessage[]; dropped: number } {
    return {
      contexts: Array.from(this.runtimeContexts.values()),
      dropped: this.runtimeContextsDropped,
    };
  }

  private trackRuntimeContext(message: CdpMessage): void {
    const context = message.params.context;
    if (
      message.method === "Runtime.executionContextCreated" &&
      context &&
      typeof context === "object"
    ) {
      const id = (context as Record<string, unknown>).id;
      if (
        typeof id !== "number" ||
        (context as Record<string, unknown>).name !== "Electron Isolated Context"
      )
        return;
      const key = JSON.stringify([message.sessionId ?? null, id]);
      if (!this.runtimeContexts.has(key) && this.runtimeContexts.size >= 2048) {
        this.runtimeContexts.delete(this.runtimeContexts.keys().next().value!);
        this.runtimeContextsDropped += 1;
      }
      this.runtimeContexts.set(key, message);
    } else if (
      message.method === "Runtime.executionContextDestroyed" &&
      typeof message.params.executionContextId === "number"
    ) {
      this.runtimeContexts.delete(
        JSON.stringify([message.sessionId ?? null, message.params.executionContextId]),
      );
    } else if (
      message.method === "Runtime.executionContextsCleared" ||
      message.method === "Target.detachedFromTarget"
    ) {
      const target =
        message.method === "Target.detachedFromTarget"
          ? message.params.sessionId
          : message.sessionId;
      if (message.method === "Target.detachedFromTarget" && typeof target !== "string") return;
      for (const [key, entry] of this.runtimeContexts)
        if (entry.sessionId === target) this.runtimeContexts.delete(key);
    }
  }

  // A newly created popup has not navigated yet. Start its first domain before
  // returning the WebContents to Chromium, while retaining normal ownership.
  public primeDomain(
    consumer: CdpConsumer,
    domain: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.disposed || consumer.closed || !this.consumers.has(consumer)) {
      throw new Error("CDP consumer is closed");
    }
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(domain) || this.domains.size !== 0) {
      throw new Error("Only a fresh CDP session can be primed");
    }
    this.ensureAttached();
    const key = JSON.stringify(["domain", domain, null]);
    const state: DomainState = {
      kind: "domain",
      domain,
      params,
      owners: new Set([consumer]),
      enabled: false,
    };
    this.domains.set(key, state);
    consumer.domains.add(key);
    const generation = this.generation;
    let pending: Promise<unknown>;
    try {
      pending = this.debuggerClient.sendCommand(`${domain}.enable`, params);
    } catch (error) {
      this.domains.delete(key);
      consumer.domains.delete(key);
      throw error;
    }
    return this.queue.run(async () => {
      try {
        await pending;
        if (this.disposed || generation !== this.generation || !this.debuggerClient.isAttached()) {
          throw new Error("CDP debugger detached during setup");
        }
        state.enabled = true;
      } catch (error) {
        this.domains.delete(key);
        consumer.domains.delete(key);
        throw error;
      }
    });
  }

  public async sendCommand(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    // Automation commands can reattach without restoring recorder-owned domains;
    // recorder consumers are notified and explicitly recover their own domains.
    return this.queue.run(async () => {
      this.ensureAttached();
      return this.debuggerClient.sendCommand(command, params ?? {}, sessionId);
    });
  }

  public async sendConsumerCommand(
    consumer: CdpConsumer,
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    return this.queue.run(async () => {
      await this.recoverConsumer(consumer);
      return this.debuggerClient.sendCommand(command, params ?? {}, sessionId);
    });
  }

  public async sendConsumerBackgroundCommand(
    consumer: CdpConsumer,
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    let commandPromise: Promise<unknown> | undefined;
    await this.queue.run(async () => {
      await this.recoverConsumer(consumer);
      commandPromise = this.debuggerClient.sendCommand(command, params ?? {}, sessionId);
      void commandPromise.catch(() => {});
    }, "background");
    return commandPromise;
  }

  public async sendImmediate(command: string, params?: Record<string, unknown>): Promise<unknown> {
    // A dialog may block the queued command that opened it. Domain recovery is
    // deliberately left to the next enable/recover call so this can unblock it.
    if (this.disposed) throw new Error("CDP session is disposed");
    if (!this.debuggerClient.isAttached()) this.debuggerClient.attach("1.3");
    this.attached = true;
    return this.debuggerClient.sendCommand(command, params ?? {});
  }

  public async enableDomain(
    consumer: CdpConsumer,
    domain: string,
    sessionId?: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(domain)) throw new Error("Invalid CDP domain");
    await this.enableState(consumer, "domain", domain, sessionId, params);
  }

  public async enableAutoAttach(consumer: CdpConsumer, sessionId?: string): Promise<void> {
    await this.enableState(consumer, "autoAttach", "Target", sessionId, {});
  }

  public async recover(consumer: CdpConsumer): Promise<void> {
    await this.queue.run(() => this.recoverConsumer(consumer));
  }

  private async enableState(
    consumer: CdpConsumer,
    kind: DomainState["kind"],
    domain: string,
    sessionId: string | undefined,
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.queue.run(async () => {
      if (consumer.closed || this.disposed) throw new Error("CDP consumer is closed");
      const key = JSON.stringify([kind, domain, sessionId ?? null]);
      const state = this.domains.get(key) ?? {
        kind,
        domain,
        sessionId,
        params: structuredClone(params),
        owners: new Set<CdpConsumer>(),
        enabled: false,
      };
      if (!isDeepStrictEqual(state.params, params))
        throw new Error(`Conflicting CDP ${domain} domain settings`);
      const alreadyOwned = state.owners.has(consumer);
      state.owners.add(consumer);
      consumer.domains.add(key);
      this.domains.set(key, state);
      try {
        this.ensureAttached();
        await this.activateState(key, state);
      } catch (error) {
        if (!alreadyOwned) {
          state.owners.delete(consumer);
          consumer.domains.delete(key);
          if (state.owners.size === 0) this.domains.delete(key);
        }
        throw error;
      }
    });
  }

  public async release(consumer: CdpConsumer): Promise<void> {
    this.consumers.delete(consumer);
    await this.queue.run(async () => {
      const errors: unknown[] = [];
      for (const key of consumer.domains) {
        const state = this.domains.get(key);
        if (!state) continue;
        state.owners.delete(consumer);
        if (state.owners.size === 0) {
          this.domains.delete(key);
          try {
            if (state.enabled && this.debuggerClient.isAttached()) await this.disableState(state);
          } catch (error) {
            errors.push(error);
          }
        }
      }
      consumer.domains.clear();
      if (errors.length)
        throw new AggregateError(errors, `CDP release failed: ${errors.map(String).join("; ")}`);
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.debuggerClient.removeListener?.("message", this.onMessage);
    this.debuggerClient.removeListener?.("detach", this.onDetach);
    this.consumers.clear();
    this.domains.clear();
    this.runtimeContexts.clear();
  }

  private ensureAttached(): void {
    if (this.disposed) throw new Error("CDP session is disposed");
    if (!this.debuggerClient.isAttached()) this.debuggerClient.attach("1.3");
    this.attached = true;
  }

  private async recoverConsumer(consumer: CdpConsumer): Promise<void> {
    if (consumer.closed || this.disposed) throw new Error("CDP consumer is closed");
    this.ensureAttached();
    for (const key of consumer.domains) {
      const state = this.domains.get(key);
      if (state) await this.activateState(key, state);
    }
  }

  private async activateState(key: string, state: DomainState): Promise<void> {
    if (state.enabled) return;
    const generation = this.generation;
    const command = state.kind === "autoAttach" ? "Target.setAutoAttach" : `${state.domain}.enable`;
    const params =
      state.kind === "autoAttach"
        ? { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
        : state.params;
    await this.debuggerClient.sendCommand(command, params, state.sessionId);
    if (
      this.disposed ||
      generation !== this.generation ||
      !this.debuggerClient.isAttached() ||
      this.domains.get(key) !== state
    ) {
      throw new Error("CDP debugger or child session detached during setup");
    }
    state.enabled = true;
  }

  private async disableState(state: DomainState): Promise<void> {
    if (state.kind === "autoAttach") {
      await this.debuggerClient.sendCommand(
        "Target.setAutoAttach",
        { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
        state.sessionId,
      );
      return;
    }
    await this.debuggerClient.sendCommand(`${state.domain}.disable`, {}, state.sessionId);
    if (state.domain === "Runtime") {
      for (const [key, entry] of this.runtimeContexts)
        if (entry.sessionId === state.sessionId) this.runtimeContexts.delete(key);
    }
  }

  private forgetChildSession(sessionId: string): void {
    for (const [key, state] of this.domains) {
      if (state.sessionId === sessionId) this.forgetState(key, state);
    }
  }

  private forgetState(key: string, state: DomainState): void {
    for (const owner of state.owners) owner.domains.delete(key);
    this.domains.delete(key);
  }
}

// Keep the original T08 regression import available; production consumers
// should import the recorder directly from browser-recording.
export { NetworkRecorder } from "../browser-recording/network-recorder.js";
