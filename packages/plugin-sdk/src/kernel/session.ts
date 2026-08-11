/**
 * Plugin SDK revision-4 kernel: the bidirectional RPC session over one
 * MessagePort, plus credit-based byte streams (rev4 §D4).
 *
 * One class serves both sides (host and plugin) — the peer is symmetric.
 * Guarantees:
 *   - requests carry deadline + optional idempotency key;
 *   - cancellation propagates as `rpc.cancel`;
 *   - streams are pull-based: the consumer issues STREAM_CREDIT, the producer
 *     never sends more bytes than granted (bounded memory, invariant 5);
 *   - every open request/stream is tracked and force-closed on `dispose()`.
 */
import { KernelError, KernelErrorCode, fromWireError, toWireError } from './errors.js';
import { parseEnvelope, type Envelope } from './protocol.js';
import { Scope } from './contracts.js';

export interface RpcRequestContext {
  id: string;
  method: string;
  params: unknown;
  instanceId: string;
  deadline: number | null;
  idempotencyKey?: string;
  signal: AbortSignal;
}

/** Metadata of a host-delivered `evt.emit` (rev4 §E1). */
export interface EventEmitMeta {
  eventId: string;
  cursor?: string;
}

export type EventEmitListener = (event: string, payload: unknown, meta: EventEmitMeta) => void;

export type RpcHandler = (context: RpcRequestContext) => Promise<unknown> | unknown;

export interface KernelSessionOptions {
  instanceId: string;
  /** Role used only for diagnostics; behavior is symmetric. */
  role: 'host' | 'plugin';
  /** Clock override for tests. */
  now?: () => number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RemoteCall {
  context: RpcRequestContext;
  abortController: AbortController;
}

interface StreamOutbound {
  /** Bytes the consumer granted that we have not yet used. */
  credit: number;
  /** Chunks queued until credit arrives (bounded by maxBufferedBytes). */
  queue: Uint8Array[];
  queuedBytes: number;
  seq: number;
  ended: boolean;
  errored: boolean;
  /** Resolves the producer's `write()` when backpressured. */
  drainWaiters: Array<() => void>;
  maxBufferedBytes: number;
}

interface StreamInbound {
  /** Bytes we have granted but not yet received. */
  grantedNotReceived: number;
  buffered: Uint8Array[];
  bufferedBytes: number;
  nextSeq: number;
  ended: boolean;
  error: KernelError | null;
  pullWaiters: Array<{ resolve: (chunk: Uint8Array | null) => void }>;
  totalReceived: number;
  maxTotalBytes: number;
}

export interface StreamLimitsConfig {
  maxInFlightBytes: number;
  maxBufferedBytesPerStream: number;
  maxTotalBytes: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimitsConfig = {
  maxInFlightBytes: 1024 * 1024,
  maxBufferedBytesPerStream: 2 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

/** A readable byte stream received from the peer. */
export class InboundStream {
  constructor(
    private readonly session: KernelSession,
    private readonly state: StreamInbound,
    readonly streamId: string,
  ) {}

  /**
   * Pull the next chunk; `null` means the stream ended cleanly. Backpressure:
   * the session replenishes credit only after the consumer pulls.
   */
  async pull(): Promise<Uint8Array | null> {
    const { state, session } = this;
    for (;;) {
      const chunk = state.buffered.shift();
      if (chunk !== undefined) {
        state.bufferedBytes -= chunk.byteLength;
        session.replenishCredit(this.streamId);
        return chunk;
      }
      if (state.error) throw state.error;
      if (state.ended) return null;
      const { promise, resolve } = Promise.withResolvers<Uint8Array | null>();
      state.pullWaiters.push({ resolve });
      const value = await promise;
      // An error may have landed while we waited; fail beats silent end.
      if (state.error) throw state.error;
      if (value !== null) {
        session.replenishCredit(this.streamId);
      }
      return value;
    }
  }

  /** Drain everything into a single Uint8Array (bounded by maxTotalBytes). */
  async collect(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (;;) {
      const chunk = await this.pull();
      if (chunk === null) break;
      parts.push(chunk);
    }
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    return merged;
  }
}

export class KernelSession {
  private readonly port: MessagePort;
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly remote = new Map<string, RemoteCall>();
  private readonly inbound = new Map<string, { state: StreamInbound; reader: InboundStream }>();
  private readonly outbound = new Map<string, StreamOutbound>();
  private readonly streamOpenListeners = new Set<
    (streamId: string, meta: Record<string, unknown>) => void
  >();
  private readonly revocationListeners = new Set<(name: string, revision: number) => void>();
  private readonly eventListeners = new Set<EventEmitListener>();
  private readonly peerCloseListeners = new Set<() => void>();
  readonly scope = new Scope();
  readonly limits: StreamLimitsConfig;
  private sequence = 0;
  private disposed = false;

  /** Session/sandbox identifier, stable for the lifetime of the session. */
  get instanceId(): string {
    return this.options.instanceId;
  }

  constructor(
    port: MessagePort,
    private readonly options: KernelSessionOptions,
    limits?: Partial<StreamLimitsConfig>,
  ) {
    this.port = port;
    this.limits = { ...DEFAULT_STREAM_LIMITS, ...limits };
    this.port.onmessage = (event: MessageEvent) => this.onMessage(event.data);
    // rev4 §M3: the peer side closed the port — the sandbox process died,
    // navigated away, or disposed its session. Consumers use this as the
    // fast crash signal (a dead renderer closes the port without any
    // heartbeat having a chance to time out).
    this.port.addEventListener?.('close', () => {
      for (const listener of [...this.peerCloseListeners]) {
        try {
          listener();
        } catch {
          // Listener errors must not break the session.
        }
      }
    });
    this.port.start?.();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Register an RPC method handler. Returns an unregister function. */
  handle(method: string, handler: RpcHandler): () => void {
    if (this.handlers.has(method)) {
      throw new KernelError(KernelErrorCode.VALIDATION_FAILED, {
        details: { reason: 'duplicate-handler', method },
      });
    }
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }

  /** Subscribe to `capability.revoked` envelopes (rev4 §B2). */
  onCapabilityRevoked(listener: (name: string, revision: number) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  /** Notify the peer that a capability grant was revoked (rev4 §B2). */
  notifyCapabilityRevoked(name: string, revision: number): void {
    this.send({ kind: 'capability.revoked', name, revision });
  }

  /**
   * rev4 §M3: subscribe to the peer side of the port closing (sandbox
   * process death, navigation away, or the peer's own dispose). The host
   * uses this as the fast crash signal for restart-budget handling.
   * Returns an unsubscribe function.
   */
  onPeerClose(listener: () => void): () => void {
    this.peerCloseListeners.add(listener);
    return () => this.peerCloseListeners.delete(listener);
  }

  /**
   * Subscribe to peer-emitted `evt.emit` envelopes (rev4 §E1). The plugin
   * side uses this to receive app events the host relays; the host side can
   * use it for plugin→host event channels. Returns an unsubscribe function.
   */
  onEvent(listener: EventEmitListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Emit an `evt.emit` envelope to the peer (rev4 §E1). No credit/ack is
   * involved: the peer drops envelopes it has no listener for. `eventId` is
   * generated by the sender for ordering/debugging; `cursor` is optional and
   * passed through when provided.
   */
  emitEvent(event: string, payload: unknown, cursor?: string): void {
    this.send({
      kind: 'evt.emit',
      event,
      payload,
      eventId: this.nextId('evt'),
      ...(cursor === undefined ? {} : { cursor }),
    });
  }

  /**
   * Invoke a remote method. Honors `deadlineMs` locally and forwards
   * cancellation; the peer may also enforce its own deadline.
   */
  call(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal; deadlineMs?: number; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new KernelError(KernelErrorCode.OPERATION_ABORTED));
    }
    const id = this.nextId('req');
    const deadline =
      options.deadlineMs === undefined ? null : this.now() + Math.max(1, options.deadlineMs);
    const envelope: Envelope = {
      kind: 'rpc.request',
      id,
      instanceId: this.options.instanceId,
      method,
      params,
      deadline,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    };
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer =
      options.deadlineMs === undefined
        ? null
        : setTimeout(
            () => {
              this.pending.delete(id);
              reject(new KernelError(KernelErrorCode.OPERATION_DEADLINE, { details: { method } }));
            },
            Math.max(1, options.deadlineMs),
          );
    this.pending.set(id, { resolve, reject, timer });
    // Register before sending: a peer that answers synchronously must not
    // race the pending-map insertion.
    this.send(envelope);
    if (options.signal) {
      if (options.signal.aborted) {
        this.cancelRequest(id);
      } else {
        options.signal.addEventListener('abort', () => this.cancelRequest(id), { once: true });
      }
    }
    return promise;
  }

  private cancelRequest(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(id);
    this.send({ kind: 'rpc.cancel', id });
    pending.reject(new KernelError(KernelErrorCode.OPERATION_ABORTED));
  }

  // ── Streams (credit-based, rev4 §D4) ──────────────────────────────────────

  /** Open a stream toward the peer; returns a writer. */
  openOutboundStream(meta: Record<string, unknown>): {
    streamId: string;
    write(chunk: Uint8Array): Promise<void>;
    end(): void;
    fail(error?: unknown): void;
  } {
    if (this.disposed) throw new KernelError(KernelErrorCode.OPERATION_ABORTED);
    const streamId = this.nextId('str');
    const state: StreamOutbound = {
      credit: 0,
      queue: [],
      queuedBytes: 0,
      seq: 0,
      ended: false,
      errored: false,
      drainWaiters: [],
      maxBufferedBytes: this.limits.maxBufferedBytesPerStream,
    };
    this.outbound.set(streamId, state);
    this.send({ kind: 'stream.open', streamId, direction: 'plugin-to-host', meta });
    const write = async (chunk: Uint8Array): Promise<void> => {
      if (state.ended || state.errored) {
        throw new KernelError(KernelErrorCode.STREAM_FAILED, { details: { reason: 'closed' } });
      }
      if (chunk.byteLength > this.limits.maxInFlightBytes) {
        // A single chunk larger than the in-flight window can never be
        // granted; fail fast instead of queueing forever.
        throw new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
          details: { limit: 'streams.maxInFlightBytes', max: this.limits.maxInFlightBytes },
        });
      }
      if (state.queuedBytes + chunk.byteLength > state.maxBufferedBytes) {
        await this.waitForDrain(state);
      }
      state.queue.push(chunk);
      state.queuedBytes += chunk.byteLength;
      this.pumpOutbound(streamId, state);
      // Await again if still backpressured after enqueue.
      if (state.queuedBytes > state.maxBufferedBytes) await this.waitForDrain(state);
    };
    return {
      streamId,
      write,
      end: () => {
        if (state.ended || state.errored) return;
        state.ended = true;
        if (state.queue.length > 0) return; // pumpOutbound sends the end
        this.send({ kind: 'stream.end', streamId });
        this.outbound.delete(streamId);
      },
      fail: (error?: unknown) => {
        if (state.errored || state.ended) return;
        state.errored = true;
        this.send({
          kind: 'stream.error',
          streamId,
          error: toWireError(error ?? new KernelError(KernelErrorCode.STREAM_FAILED)),
        });
        this.outbound.delete(streamId);
      },
    };
  }

  /** Subscribe to streams the peer opens toward us. */
  onInboundStream(listener: (streamId: string, meta: Record<string, unknown>) => void): () => void {
    this.streamOpenListeners.add(listener);
    return () => this.streamOpenListeners.delete(listener);
  }

  getInboundStream(streamId: string): InboundStream | null {
    return this.inbound.get(streamId)?.reader ?? null;
  }

  /** Internal: top up credit for a stream the consumer just read from. */
  replenishCredit(streamId: string): void {
    const entry = this.inbound.get(streamId);
    if (!entry) return;
    const state = entry.state;
    const outstanding = this.limits.maxInFlightBytes - state.grantedNotReceived;
    if (outstanding <= 0) return;
    state.grantedNotReceived += outstanding;
    this.send({ kind: 'stream.credit', streamId, bytes: outstanding });
  }

  // ── Wire handling ─────────────────────────────────────────────────────────

  private onMessage(raw: unknown): void {
    if (this.disposed) return;
    const envelope = parseEnvelope(raw);
    if (!envelope) return; // malformed or unknown kinds are ignored
    switch (envelope.kind) {
      case 'rpc.request':
        void this.serveRequest(envelope);
        return;
      case 'rpc.response': {
        const pending = this.pending.get(envelope.id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(envelope.id);
        if (envelope.ok) pending.resolve(envelope.result);
        else pending.reject(fromWireError(envelope.error));
        return;
      }
      case 'rpc.cancel': {
        const call = this.remote.get(envelope.id);
        if (call) {
          this.remote.delete(envelope.id);
          call.abortController.abort();
        }
        return;
      }
      case 'stream.open': {
        const state: StreamInbound = {
          grantedNotReceived: 0,
          buffered: [],
          bufferedBytes: 0,
          nextSeq: 0,
          ended: false,
          error: null,
          pullWaiters: [],
          totalReceived: 0,
          maxTotalBytes: this.limits.maxTotalBytes,
        };
        const reader = new InboundStream(this, state, envelope.streamId);
        this.inbound.set(envelope.streamId, { state, reader });
        // Grant an initial window so the producer can start.
        state.grantedNotReceived = this.limits.maxInFlightBytes;
        this.send({
          kind: 'stream.credit',
          streamId: envelope.streamId,
          bytes: this.limits.maxInFlightBytes,
        });
        for (const listener of [...this.streamOpenListeners]) {
          try {
            listener(envelope.streamId, envelope.meta);
          } catch {
            // Listener errors must not break the session.
          }
        }
        return;
      }
      case 'stream.credit': {
        const state = this.outbound.get(envelope.streamId);
        if (!state) return;
        state.credit += envelope.bytes;
        this.pumpOutbound(envelope.streamId, state);
        return;
      }
      case 'stream.chunk': {
        const entry = this.inbound.get(envelope.streamId);
        if (!entry) return;
        const state = entry.state;
        if (state.ended || state.error) return;
        if (envelope.seq !== state.nextSeq) return; // out-of-order: drop
        state.nextSeq += 1;
        const chunk = new Uint8Array(envelope.buffer);
        state.totalReceived += chunk.byteLength;
        state.grantedNotReceived = Math.max(0, state.grantedNotReceived - chunk.byteLength);
        if (state.totalReceived > state.maxTotalBytes) {
          this.failInbound(
            envelope.streamId,
            state,
            new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
              details: { limit: 'streams.maxTotalBytes', max: state.maxTotalBytes },
            }),
          );
          return;
        }
        const waiter = state.pullWaiters.shift();
        if (waiter) {
          waiter.resolve(chunk);
        } else {
          state.buffered.push(chunk);
          state.bufferedBytes += chunk.byteLength;
        }
        return;
      }
      case 'stream.end': {
        const entry = this.inbound.get(envelope.streamId);
        if (!entry) return;
        entry.state.ended = true;
        for (const waiter of entry.state.pullWaiters.splice(0)) waiter.resolve(null);
        this.inbound.delete(envelope.streamId);
        return;
      }
      case 'stream.error': {
        const entry = this.inbound.get(envelope.streamId);
        if (!entry) return;
        this.failInbound(envelope.streamId, entry.state, fromWireError(envelope.error));
        return;
      }
      case 'stream.cancel': {
        const state = this.outbound.get(envelope.streamId);
        if (!state) return;
        state.errored = true;
        for (const waiter of state.drainWaiters.splice(0)) waiter();
        this.outbound.delete(envelope.streamId);
        return;
      }
      case 'capability.revoked':
        for (const listener of [...this.revocationListeners]) {
          try {
            listener(envelope.name, envelope.revision);
          } catch {
            // Listener errors must not break the session.
          }
        }
        return;
      case 'evt.emit':
        for (const listener of [...this.eventListeners]) {
          try {
            listener(envelope.event, envelope.payload, {
              eventId: envelope.eventId,
              ...(envelope.cursor === undefined ? {} : { cursor: envelope.cursor }),
            });
          } catch {
            // Listener errors must not break the session.
          }
        }
        return;
      case 'lifecycle':
        // Delivered through dedicated host/plugin APIs layered above.
        return;
    }
  }

  private failInbound(streamId: string, state: StreamInbound, error: KernelError): void {
    state.error = error;
    for (const waiter of state.pullWaiters.splice(0)) {
      // Wake pull() — it re-checks error and throws.
      waiter.resolve(null);
    }
    this.inbound.delete(streamId);
  }

  private async serveRequest(envelope: Extract<Envelope, { kind: 'rpc.request' }>): Promise<void> {
    const handler = this.handlers.get(envelope.method);
    const abortController = new AbortController();
    const context: RpcRequestContext = {
      id: envelope.id,
      method: envelope.method,
      params: envelope.params,
      instanceId: envelope.instanceId,
      deadline: envelope.deadline,
      signal: abortController.signal,
      ...(envelope.idempotencyKey === undefined ? {} : { idempotencyKey: envelope.idempotencyKey }),
    };
    if (!handler) {
      this.send({
        kind: 'rpc.response',
        id: envelope.id,
        ok: false,
        error: {
          code: KernelErrorCode.PROTOCOL_UNSUPPORTED,
          retryable: false,
          details: { method: envelope.method },
        },
      });
      return;
    }
    // Enforce the caller's deadline locally too (defense in depth).
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    if (envelope.deadline !== null) {
      const remaining = envelope.deadline - this.now();
      if (remaining <= 0) {
        this.send({
          kind: 'rpc.response',
          id: envelope.id,
          ok: false,
          error: { code: KernelErrorCode.OPERATION_DEADLINE, retryable: true },
        });
        return;
      }
      deadlineTimer = setTimeout(() => abortController.abort(), remaining);
    }
    this.remote.set(envelope.id, { context, abortController });
    try {
      const result = await handler(context);
      if (abortController.signal.aborted) {
        this.send({
          kind: 'rpc.response',
          id: envelope.id,
          ok: false,
          error: { code: KernelErrorCode.OPERATION_ABORTED, retryable: false },
        });
      } else {
        this.send({ kind: 'rpc.response', id: envelope.id, ok: true, result });
      }
    } catch (error) {
      this.send({ kind: 'rpc.response', id: envelope.id, ok: false, error: toWireError(error) });
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.remote.delete(envelope.id);
    }
  }

  private pumpOutbound(streamId: string, state: StreamOutbound): void {
    while (state.credit > 0 && state.queue.length > 0) {
      const chunk = state.queue[0];
      if (!chunk) break;
      if (chunk.byteLength > state.credit) break;
      state.queue.shift();
      const seq = state.seq;
      state.seq += 1;
      const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      this.port.postMessage({ kind: 'stream.chunk', streamId, seq, buffer }, [buffer]);
    }
    if (state.ended && state.queue.length === 0) {
      // Deferred termination: every chunk is on the wire, close the stream.
      this.send({ kind: 'stream.end', streamId });
      this.outbound.delete(streamId);
      return;
    }
    if (state.queuedBytes <= state.maxBufferedBytes / 2) {
      for (const waiter of state.drainWaiters.splice(0)) waiter();
    }
  }

  private waitForDrain(state: StreamOutbound): Promise<void> {
    if (state.errored) {
      return Promise.reject(new KernelError(KernelErrorCode.STREAM_FAILED));
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    state.drainWaiters.push(resolve);
    return promise;
  }

  private send(envelope: Envelope): void {
    if (this.disposed) return;
    try {
      this.port.postMessage(envelope);
    } catch {
      // Port closed mid-teardown; dropping is the only sane option.
    }
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${this.options.role}:${prefix}:${this.sequence}`;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Close everything: pending calls, in-flight streams, handlers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new KernelError(KernelErrorCode.OPERATION_ABORTED));
    }
    this.pending.clear();
    for (const [, call] of this.remote) call.abortController.abort();
    this.remote.clear();
    for (const [streamId, entry] of this.inbound) {
      this.failInbound(streamId, entry.state, new KernelError(KernelErrorCode.OPERATION_ABORTED));
    }
    for (const [, state] of this.outbound) {
      for (const waiter of state.drainWaiters.splice(0)) waiter();
    }
    this.outbound.clear();
    this.scope.dispose();
    try {
      this.port.close();
    } catch {
      // Already closed.
    }
  }
}
