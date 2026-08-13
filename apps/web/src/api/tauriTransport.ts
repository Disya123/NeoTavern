/**
 * TauriTransport — LocalTransport over the Tauri local IPC (ТЗ §11.1/§15.1).
 *
 * React → LocalBackend → Tauri IPC → Runtime Kernel:
 *
 * - every outbound call is a `wire.request.envelope` JSON dispatched to the
 *   `kernel_dispatch` command; the answer is a validated
 *   `wire.response.envelope` JSON — byte-identical to what the CLI and the
 *   remote-http adapter produce for the same operation (§6.3);
 * - product errors come back as error envelopes and surface as
 *   `{ok:false, error}`; transport failures (unparseable body, IPC error)
 *   throw a typed error, mirroring the RemoteBackend split between product
 *   and transport errors;
 * - streams open via `kernel_stream_start` with a Tauri `Channel`; the
 *   background poller forwards committed `wire.event.envelope` values and a
 *   `null` end-of-stream sentinel (transport framing, like the SSE
 *   `stream.closed` frame). Aborting the iterator requests `kernel_stream_abort`,
 *   which cancels the durable run (§63).
 *
 * No localhost, no sockets: this transport never touches the network.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { ProductError, TransportError, type StreamEvent } from '@neotavern/client-sdk';
import { WIRE_PROTOCOL, WIRE_SCHEMA_HASH } from '@neotavern/contracts';
import type { ProductErrorDto } from '@neotavern/contracts';
import type { LocalCallResult, LocalTransport } from '@neotavern/neobackend';

/** Structural shape of the outgoing request envelope (`wire.request.envelope`). */
interface WireRequestEnvelope {
  wireProtocol: { major: number; minor: number };
  schemaHash: string;
  requestId: string;
  operationId: string;
  payload: unknown;
}

/** Structural shape of the response envelope (`wire.response.envelope`). */
type WireResponseEnvelope =
  | { kind: 'ok'; requestId: string; result: unknown }
  | { kind: 'error'; requestId: string; error: ProductErrorDto };

/** A committed `wire.event.envelope` pushed by the kernel poller. */
interface WireEventEnvelope {
  streamId: string;
  sequence: number;
  type: string;
  payload: unknown;
}

/** The channel surface the transport needs (Tauri `Channel` satisfies it). */
export interface TauriChannelLike {
  onmessage: ((message: unknown) => void) | undefined;
}

/** A parked `next()` call waiting for an event, the end or an error. */
interface StreamWaiter {
  resolve: (result: IteratorResult<StreamEvent, void>) => void;
  reject: (error: Error) => void;
}

/**
 * Resolves parked `next()` calls: queued events first, then the end/error
 * state. Shared by the channel handler and the stream-open closure.
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

/** Whether the current window runs inside the Tauri desktop shell. */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * LocalTransport implementation for the Tauri desktop shell.
 *
 * `call` aborts are intentionally not wired to cancellation: local unary
 * dispatch is transactional and near-instant; durable cancellation goes
 * through the explicit `generation.cancel` operation.
 */
export class TauriTransport implements LocalTransport {
  private readonly invokeImpl: typeof invoke;
  private readonly channelCtor: typeof Channel;

  constructor(options?: {
    /** Injectable `invoke` for tests. */
    invoke?: typeof invoke;
    /** Injectable `Channel` constructor for tests. */
    channel?: typeof Channel;
    /** Injectable request-id generator (defaults to `crypto.randomUUID`). */
    requestId?: () => string;
  }) {
    this.invokeImpl = options?.invoke ?? invoke;
    this.channelCtor = options?.channel ?? Channel;
    this.requestId = options?.requestId ?? (() => crypto.randomUUID());
  }

  private readonly requestId: () => string;

  /**
   * Creates the event channel for one stream. Defaults to a Tauri `Channel`;
   * subclasses override this as a test seam.
   */
  protected createChannel(): TauriChannelLike {
    return new this.channelCtor<unknown>();
  }

  async call(
    operationId: string,
    payload: unknown,
    _opts: { signal?: AbortSignal } = {},
  ): Promise<LocalCallResult> {
    let response: string;
    try {
      response = await this.invokeImpl<string>('kernel_dispatch', {
        envelope: JSON.stringify(this.buildEnvelope(operationId, payload)),
      });
    } catch (error) {
      throw new TransportError({
        message: `local kernel dispatch failed: ${String(error)}`,
        retryable: false,
        timeout: false,
        cause: error,
      });
    }
    return this.parseResponse(response);
  }

  stream(
    operationId: string,
    payload: unknown,
    _opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<StreamEvent> {
    const channel = this.createChannel();
    const queue: StreamEvent[] = [];
    const waiters: StreamWaiter[] = [];
    let ended = false;
    let aborted = false;
    let streamId: string | undefined;
    let openError: Error | undefined;

    channel.onmessage = (message: unknown) => {
      if (message === null) {
        ended = true;
      } else {
        const envelope = message as WireEventEnvelope;
        streamId ??= envelope.streamId;
        queue.push({
          streamId: envelope.streamId,
          sequence: envelope.sequence,
          type: envelope.type,
          payload: envelope.payload,
        });
      }
      settleWaiters(waiters, queue, ended, openError);
    };

    // Eager open on an independent promise chain: it survives an early
    // `return()` and still learns the stream id for the durable cancel.
    void (async () => {
      try {
        const response = await this.invokeImpl<string>('kernel_stream_start', {
          envelope: JSON.stringify(this.buildEnvelope(operationId, payload)),
          onEvent: channel,
        });
        const parsed = this.parseResponse(response);
        if (!parsed.ok) {
          openError = new ProductError(parsed.error);
          ended = true;
        } else {
          // The adapter echoes the kernel stream id in the ok result so the
          // consumer can abort the stream before the first event arrives.
          const result = parsed.value as { streamId?: string } | null;
          streamId = result?.streamId ?? undefined;
          if (aborted && streamId !== undefined) {
            void this.invokeImpl('kernel_stream_abort', { streamId });
          }
        }
      } catch (error) {
        openError =
          error instanceof TransportError
            ? error
            : new TransportError({
                message: `local kernel stream open failed: ${String(error)}`,
                retryable: false,
                timeout: false,
                cause: error,
              });
        ended = true;
      }
      settleWaiters(waiters, queue, ended, openError);
    })();

    return {
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent, void, void> => ({
        next: (): Promise<IteratorResult<StreamEvent, void>> => {
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
        },
        return: (): Promise<IteratorResult<StreamEvent, void>> => {
          // Consumer left early (abort/unmount): request a durable cancel so
          // the run lands in a recoverable terminal state instead of
          // streaming into a dead channel (§63). Best-effort, idempotent.
          aborted = true;
          if (streamId !== undefined) {
            void this.invokeImpl('kernel_stream_abort', { streamId });
          }
          for (const waiter of waiters.splice(0)) {
            waiter.resolve({ done: true, value: undefined });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
  }

  private buildEnvelope(operationId: string, payload: unknown): WireRequestEnvelope {
    return {
      wireProtocol: { major: WIRE_PROTOCOL.major, minor: WIRE_PROTOCOL.minor },
      schemaHash: WIRE_SCHEMA_HASH,
      requestId: this.requestId(),
      operationId,
      payload,
    };
  }

  private parseResponse(body: string): LocalCallResult {
    let envelope: WireResponseEnvelope;
    try {
      envelope = JSON.parse(body) as WireResponseEnvelope;
    } catch (error) {
      throw new TransportError({
        message: 'local kernel response was not valid JSON',
        retryable: false,
        timeout: false,
        cause: error,
      });
    }
    if (envelope.kind === 'ok') {
      return { ok: true, value: envelope.result };
    }
    return { ok: false, error: envelope.error };
  }
}
