/**
 * MobileBridgeTransport — LocalTransport over the Android WebView JS bridge
 * (ТЗ §7.2 Phase 5).
 *
 * The Android host injects `window.__neotavernMobile` into the WebView:
 *
 * - `handshake()` synchronously returns the host's wire handshake JSON
 *   (`{ffiAbiVersion, schemaHash, wireProtocol, appVersion}`); a schema-hash
 *   mismatch throws `ContractMismatchError` before the first call;
 * - unary calls are fire-and-forget: `call(requestId, envelopeJson,
 *   callbackId)`; the native side later evaluates
 *   `window.__neotavernMobileCallbacks.resolve(callbackId, envelope)` (or
 *   `.reject(callbackId, error)`). The transport installs that callback
 *   surface before invoking the bridge;
 * - streams deliver `{kind:"event"|"terminal"|"error"}` payload objects on
 *   the same callback surface; `return()` requests a durable cancel via
 *   `cancelStream(streamId)`.
 *
 * The request envelope framing is byte-identical to `TauriTransport` (shared
 * `buildRequestEnvelope`), so the kernel adapter cannot tell the shells
 * apart. Envelope parsing validates only the minimal shape (kind + requestId
 * echo); `LocalBackend` re-validates every payload against the wire schemas.
 */
import { ProductError, TransportError, type StreamEvent } from '@neotavern/client-sdk';
import { WIRE_SCHEMA_HASH, type ProductErrorDto } from '@neotavern/contracts';
import {
  ContractMismatchError,
  type LocalCallResult,
  type LocalTransport,
} from '@neotavern/neobackend';
import { buildRequestEnvelope } from './wireEnvelope.js';

export { TransportError };

/** The Android host's JS bridge surface (`window.__neotavernMobile`). */
export interface MobileBridgeLike {
  /** Synchronous handshake JSON: `{ffiAbiVersion, schemaHash, wireProtocol, appVersion}`. */
  handshake(): string;
  /** Fire-and-forget dispatch of one wire envelope; the answer arrives on the callback surface. */
  call(requestId: string, envelopeJson: string, callbackId: string): void;
  /** Durable cancel of an open stream. */
  cancelStream(streamId: string): void;
}

/** Parsed mobile handshake (ТЗ §7.2 Phase 5). */
export interface MobileHandshake {
  ffiAbiVersion: number;
  schemaHash: string;
  wireProtocol: { major: number; minor: number };
  appVersion: string;
}

/** A committed `wire.event.envelope` carried in a stream event payload. */
interface WireEventEnvelope {
  streamId: string;
  sequence: number;
  type: string;
  payload: unknown;
}

/** A stream callback payload delivered by the bridge (`kind` discriminated). */
type StreamCallbackPayload =
  | { kind: 'event'; event: WireEventEnvelope }
  | { kind: 'terminal' }
  | { kind: 'error'; error: ProductErrorDto };

/** A parked `next()` call waiting for an event, the end or an error. */
interface StreamWaiter {
  resolve: (result: IteratorResult<StreamEvent, void>) => void;
  reject: (error: Error) => void;
}

/** A pending bridge callback: a unary response or an open stream. */
interface PendingCallback {
  resolve: (payload: unknown) => void;
  reject: (payload: unknown) => void;
}

/** The callback surface the host evaluates into (`window.__neotavernMobileCallbacks`). */
interface MobileCallbackSurface {
  resolve: (callbackId: string, envelope: unknown) => void;
  reject: (callbackId: string, error: unknown) => void;
}

/**
 * All in-flight bridge callbacks, keyed by the per-transport callback id.
 * Module-level because the host evaluates into a single global surface: the
 * surface must keep routing deliveries correctly no matter which transport
 * instance installed it first.
 */
const pendingByCallbackId = new Map<string, PendingCallback>();

/**
 * Install `window.__neotavernMobileCallbacks` once. MUST run before the first
 * `bridge.call(...)`; a delivery for an unknown callback id (late response
 * after abort/timeout/return) is ignored — the caller's own timeout covers it.
 */
function installCallbackSurface(): void {
  if (typeof window === 'undefined') return;
  const target = window as unknown as { __neotavernMobileCallbacks?: MobileCallbackSurface };
  if (target.__neotavernMobileCallbacks !== undefined) return;
  target.__neotavernMobileCallbacks = {
    resolve: (callbackId, envelope) => {
      pendingByCallbackId.get(callbackId)?.resolve(envelope);
    },
    reject: (callbackId, error) => {
      pendingByCallbackId.get(callbackId)?.reject(error);
    },
  };
}

/**
 * Resolves parked `next()` calls: queued events first, then the end/error
 * state. Shared by the stream payload handler and the stream-open closure
 * (same policy as `TauriTransport.settleWaiters`).
 */
function settleWaiters(
  waiters: StreamWaiter[],
  queue: StreamEvent[],
  ended: boolean,
  openError: Error | undefined,
): void {
  while (waiters.length > 0 && queue.length > 0) {
    const waiter = waiters.shift();
    const event = queue.shift();
    if (waiter === undefined || event === undefined) continue;
    waiter.resolve({ done: false, value: event });
  }
  if (waiters.length > 0 && ended) {
    for (const waiter of waiters.splice(0)) {
      if (openError !== undefined) {
        waiter.reject(openError);
      } else {
        waiter.resolve({ done: true, value: undefined });
      }
    }
  }
}

/**
 * LocalTransport implementation for the Android WebView shell.
 *
 * `call` aborts are not wired to kernel cancellation: local unary dispatch is
 * transactional and near-instant; durable cancellation goes through the
 * explicit `generation.cancel` operation (same stance as `TauriTransport`).
 */
export class MobileBridgeTransport implements LocalTransport {
  private static nextInstance = 0;

  private readonly requestId: () => string;
  private readonly callTimeoutMs: number;
  private readonly instanceId: number;
  private callbackCounter = 0;
  private handshakePromise: Promise<MobileHandshake> | undefined;

  constructor(options?: {
    /** Injectable request-id generator (defaults to `crypto.randomUUID`). */
    requestId?: () => string;
    /** Unary callback timeout in ms (default 15000); a timeout throws `TransportError`. */
    callTimeoutMs?: number;
  }) {
    this.instanceId = MobileBridgeTransport.nextInstance;
    MobileBridgeTransport.nextInstance += 1;
    this.requestId = options?.requestId ?? (() => crypto.randomUUID());
    this.callTimeoutMs = options?.callTimeoutMs ?? 15000;
  }

  /** The host bridge, when this window runs inside the mobile shell. */
  private bridge(): MobileBridgeLike | undefined {
    if (typeof window === 'undefined') return undefined;
    return (window as unknown as { __neotavernMobile?: MobileBridgeLike }).__neotavernMobile;
  }

  private nextCallbackId(): string {
    this.callbackCounter += 1;
    return `nt-${this.instanceId}-${this.callbackCounter}`;
  }

  /**
   * Read the bridge handshake once and verify the wire contract matches.
   * Failures are not cached: a transient bridge hiccup must not wedge every
   * later call, and a contract mismatch reports the same typed error on retry.
   */
  async ensureHandshake(): Promise<MobileHandshake> {
    if (this.handshakePromise === undefined) {
      this.handshakePromise = this.getHandshake().catch((error: unknown) => {
        this.handshakePromise = undefined;
        throw error;
      });
    }
    return this.handshakePromise;
  }

  /** Query `window.__neotavernMobile.handshake()` and parse its JSON. */
  async getHandshake(): Promise<MobileHandshake> {
    const bridge = this.bridge();
    if (bridge === undefined) {
      throw new TransportError({
        message: 'mobile bridge unavailable',
        retryable: false,
        timeout: false,
      });
    }
    let raw: string;
    try {
      raw = bridge.handshake();
    } catch (error) {
      throw new TransportError({
        message: `mobile bridge handshake failed: ${String(error)}`,
        retryable: false,
        timeout: false,
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new TransportError({
        message: 'mobile bridge handshake was not valid JSON',
        retryable: false,
        timeout: false,
        cause: error,
      });
    }
    const handshake = parsed as MobileHandshake;
    if (
      handshake === null ||
      typeof handshake !== 'object' ||
      typeof handshake.schemaHash !== 'string'
    ) {
      throw new TransportError({
        message: 'mobile bridge handshake was malformed',
        retryable: false,
        timeout: false,
      });
    }
    if (handshake.schemaHash !== WIRE_SCHEMA_HASH) {
      throw new ContractMismatchError({
        expectedSchemaHash: WIRE_SCHEMA_HASH,
        actualSchemaHash: handshake.schemaHash,
      });
    }
    return handshake;
  }

  async call(
    operationId: string,
    payload: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<LocalCallResult> {
    await this.ensureHandshake();
    const bridge = this.bridge();
    if (bridge === undefined) {
      throw new TransportError({
        message: 'mobile bridge unavailable',
        retryable: false,
        timeout: false,
      });
    }
    if (opts.signal?.aborted) {
      throw new TransportError({
        message: 'mobile call aborted',
        retryable: false,
        timeout: false,
      });
    }
    const requestId = this.requestId();
    const callbackId = this.nextCallbackId();
    const envelopeJson = JSON.stringify(buildRequestEnvelope({ requestId, operationId, payload }));

    return new Promise<LocalCallResult>((resolvePromise, rejectPromise) => {
      let settled = false;

      const settleResolve = (result: LocalCallResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingByCallbackId.delete(callbackId);
        opts.signal?.removeEventListener('abort', onAbort);
        resolvePromise(result);
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingByCallbackId.delete(callbackId);
        opts.signal?.removeEventListener('abort', onAbort);
        rejectPromise(error);
      };

      const entry: PendingCallback = {
        resolve: (raw) => {
          try {
            settleResolve(this.parseResponse(raw, requestId));
          } catch (error) {
            settleReject(
              error instanceof TransportError
                ? error
                : new TransportError({
                    message: `mobile bridge response failed: ${String(error)}`,
                    retryable: false,
                    timeout: false,
                    cause: error,
                  }),
            );
          }
        },
        reject: (raw) => {
          settleReject(this.toTransportError(raw, 'mobile bridge call rejected'));
        },
      };
      pendingByCallbackId.set(callbackId, entry);

      const timer = setTimeout(() => {
        settleReject(
          new TransportError({
            message: 'mobile bridge call timed out',
            retryable: false,
            timeout: true,
          }),
        );
      }, this.callTimeoutMs);

      const onAbort = (): void => {
        settleReject(
          new TransportError({
            message: 'mobile call aborted',
            retryable: false,
            timeout: false,
          }),
        );
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      installCallbackSurface();
      try {
        bridge.call(requestId, envelopeJson, callbackId);
      } catch (error) {
        settleReject(
          new TransportError({
            message: `mobile bridge call failed: ${String(error)}`,
            retryable: false,
            timeout: false,
            cause: error,
          }),
        );
      }
    });
  }

  stream(
    operationId: string,
    payload: unknown,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<StreamEvent> {
    const queue: StreamEvent[] = [];
    const waiters: StreamWaiter[] = [];
    let ended = false;
    let aborted = false;
    let streamId: string | undefined;
    let callbackId: string | undefined;
    let openError: Error | undefined;

    const deliver = (raw: unknown): void => {
      let eventPayload: unknown;
      try {
        eventPayload = this.parseDelivered(raw, 'stream payload');
      } catch (error) {
        openError =
          error instanceof TransportError
            ? error
            : new TransportError({
                message: `mobile bridge stream payload failed: ${String(error)}`,
                retryable: false,
                timeout: false,
                cause: error,
              });
        ended = true;
        settleWaiters(waiters, queue, ended, openError);
        return;
      }
      if (
        eventPayload === null ||
        typeof eventPayload !== 'object' ||
        typeof (eventPayload as { kind?: unknown }).kind !== 'string'
      ) {
        openError = new TransportError({
          message: 'mobile bridge stream payload was malformed',
          retryable: false,
          timeout: false,
        });
        ended = true;
        settleWaiters(waiters, queue, ended, openError);
        return;
      }
      const payload = eventPayload as StreamCallbackPayload;
      const kind = payload.kind;
      if (kind === 'event') {
        const envelope = payload.event;
        if (
          envelope === null ||
          typeof envelope !== 'object' ||
          typeof (envelope as { streamId?: unknown }).streamId !== 'string' ||
          typeof (envelope as { sequence?: unknown }).sequence !== 'number' ||
          typeof (envelope as { type?: unknown }).type !== 'string'
        ) {
          openError = new TransportError({
            message: 'mobile bridge stream event envelope was malformed',
            retryable: false,
            timeout: false,
          });
          ended = true;
          settleWaiters(waiters, queue, ended, openError);
          return;
        }
        const event = envelope as WireEventEnvelope;
        streamId ??= event.streamId;
        if (aborted && streamId !== undefined) {
          // Consumer left before the first event learned the stream id:
          // cancel as soon as the id becomes known (best-effort, idempotent).
          try {
            this.bridge()?.cancelStream(streamId);
          } catch {
            // best-effort durable cancel; ignore host failures
          }
        }
        queue.push({
          streamId: event.streamId,
          sequence: event.sequence,
          type: event.type,
          payload: event.payload,
        });
      } else if (kind === 'terminal') {
        ended = true;
        if (callbackId !== undefined) pendingByCallbackId.delete(callbackId);
      } else if (kind === 'error') {
        const error = payload.error;
        if (error === null || typeof error !== 'object') {
          openError = new TransportError({
            message: 'mobile bridge stream error payload was malformed',
            retryable: false,
            timeout: false,
          });
        } else {
          openError = new ProductError(error as ProductErrorDto);
        }
        ended = true;
        if (callbackId !== undefined) pendingByCallbackId.delete(callbackId);
      } else {
        openError = new TransportError({
          message: `mobile bridge stream delivered unknown payload kind: ${kind}`,
          retryable: false,
          timeout: false,
        });
        ended = true;
      }
      settleWaiters(waiters, queue, ended, openError);
    };

    // Eager open on an independent promise chain: it survives an early
    // `return()` and still learns the stream id for the durable cancel.
    void (async () => {
      try {
        await this.ensureHandshake();
        const bridge = this.bridge();
        if (bridge === undefined) {
          throw new TransportError({
            message: 'mobile bridge unavailable',
            retryable: false,
            timeout: false,
          });
        }
        const requestId = this.requestId();
        callbackId = this.nextCallbackId();
        const envelopeJson = JSON.stringify(
          buildRequestEnvelope({ requestId, operationId, payload }),
        );
        pendingByCallbackId.set(callbackId, {
          resolve: (raw) => deliver(raw),
          reject: (raw) => {
            openError = this.toTransportError(raw, 'mobile bridge stream rejected');
            ended = true;
            if (callbackId !== undefined) pendingByCallbackId.delete(callbackId);
            settleWaiters(waiters, queue, ended, openError);
          },
        });
        installCallbackSurface();
        bridge.call(requestId, envelopeJson, callbackId);
      } catch (error) {
        if (callbackId !== undefined) pendingByCallbackId.delete(callbackId);
        openError =
          error instanceof TransportError
            ? error
            : new TransportError({
                message: `mobile bridge stream open failed: ${String(error)}`,
                retryable: false,
                timeout: false,
                cause: error,
              });
        ended = true;
      }
      settleWaiters(waiters, queue, ended, openError);
    })();

    const next = (): Promise<IteratorResult<StreamEvent, void>> => {
      const event = queue.shift();
      if (event !== undefined) {
        streamId ??= event.streamId;
        return Promise.resolve({ done: false, value: event });
      }
      if (ended) {
        if (openError !== undefined) {
          return Promise.reject(openError);
        }
        return Promise.resolve({ done: true, value: undefined });
      }
      return new Promise((resolvePromise, rejectPromise) => {
        waiters.push({ resolve: resolvePromise, reject: rejectPromise });
      });
    };

    const doReturn = (): Promise<IteratorResult<StreamEvent, void>> => {
      // Consumer left early (abort/unmount): request a durable cancel so the
      // run lands in a recoverable terminal state instead of streaming into
      // a dead callback (mirrors `TauriTransport`'s kernel_stream_abort).
      aborted = true;
      if (streamId !== undefined) {
        try {
          this.bridge()?.cancelStream(streamId);
        } catch {
          // best-effort durable cancel; ignore host failures
        }
      }
      if (callbackId !== undefined) pendingByCallbackId.delete(callbackId);
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ done: true, value: undefined });
      }
      return Promise.resolve({ done: true, value: undefined });
    };

    const makeIterator = (): AsyncIterator<StreamEvent, void, void> => ({
      next,
      return: doReturn,
    });

    const signal = opts.signal;
    if (signal !== undefined) {
      const onAbort = (): void => {
        void makeIterator().return?.();
      };
      if (signal.aborted) {
        queueMicrotask(onAbort);
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    return { [Symbol.asyncIterator]: makeIterator };
  }

  /** Parse a delivered envelope, tolerating a host that double-encodes. */
  private parseDelivered(raw: unknown, what: string): unknown {
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new TransportError({
        message: `mobile bridge ${what} was not valid JSON`,
        retryable: false,
        timeout: false,
        cause: error,
      });
    }
  }

  /**
   * Parse a unary response envelope. Validates only the minimal shape (kind
   * plus the requestId echo); `LocalBackend` re-validates the payload against
   * the wire schemas.
   */
  private parseResponse(raw: unknown, requestId: string): LocalCallResult {
    let envelope: unknown;
    try {
      envelope = this.parseDelivered(raw, 'response');
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError({
        message: 'mobile bridge response was not valid JSON',
        retryable: false,
        timeout: false,
        cause: error,
      });
    }
    if (envelope === null || typeof envelope !== 'object') {
      throw new TransportError({
        message: 'mobile bridge response envelope was malformed',
        retryable: false,
        timeout: false,
      });
    }
    const record = envelope as Record<string, unknown>;
    if (record.requestId !== requestId) {
      throw new TransportError({
        message: 'mobile bridge response requestId echo mismatch',
        retryable: false,
        timeout: false,
      });
    }
    if (record.kind === 'ok') {
      return { ok: true, value: record.result };
    }
    if (record.kind === 'error') {
      return { ok: false, error: record.error as ProductErrorDto };
    }
    throw new TransportError({
      message: `mobile bridge response envelope has unknown kind: ${String(record.kind)}`,
      retryable: false,
      timeout: false,
    });
  }

  /** Map a bridge `reject` payload onto a typed `TransportError`. */
  private toTransportError(payload: unknown, fallbackMessage: string): TransportError {
    let message = fallbackMessage;
    let parsed: unknown = payload;
    if (typeof payload === 'string') {
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = payload;
      }
    }
    if (parsed !== null && typeof parsed === 'object') {
      const candidate = (parsed as { message?: unknown }).message;
      if (typeof candidate === 'string') message = candidate;
    }
    return new TransportError({ message, retryable: false, timeout: false });
  }
}
