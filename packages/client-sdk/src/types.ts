/**
 * @neotavern/client-sdk — public types.
 *
 * Wire DTO types are derived from the `@neotavern/contracts` schemas via
 * TypeBox `Static` so they can never drift from the single source of truth.
 */

import type { Static } from '@sinclair/typebox';
import type {
  EventEnvelopeSchema,
  MetaDtoSchema,
  ProductErrorDtoSchema,
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
} from '@neotavern/contracts';

/** Server meta information returned by `GET /meta` (`wire.meta.dto`). */
export type MetaDto = Static<typeof MetaDtoSchema>;

/** Wire product error DTO (`wire.error.dto`). */
export type ProductErrorDto = Static<typeof ProductErrorDtoSchema>;

/** Canonical request envelope (`wire.request.envelope`). */
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;

/** Canonical response envelope (`wire.response.envelope`), tagged by `kind`. */
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;

/** Canonical event envelope (`wire.event.envelope`). */
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;

/** Options for a single {@link Transport.call} invocation. */
export interface CallOptions {
  /** Abort signal; aborting cancels the in-flight request. */
  signal?: AbortSignal;
  /**
   * Timeout in milliseconds. When it elapses the request is aborted and the
   * call fails with a `TransportError` carrying `timeout: true`.
   */
  timeoutMs?: number;
  /**
   * Optional idempotency key. Transmitted as the `Idempotency-Key` header
   * when present (the canonical envelope has no dedicated field).
   */
  idempotencyKey?: string;
}

/** Options for {@link Transport.stream}. */
export interface StreamOptions {
  /** Abort signal; aborting cancels the stream. */
  signal?: AbortSignal;
}

/** Result of a {@link Transport.call} invocation (discriminated union). */
export type CallResult<T> = { ok: true; value: T } | { ok: false; error: ProductErrorDto };

/** One event yielded by {@link Transport.stream}. */
export interface StreamEvent {
  /** Stream identifier from the event envelope. */
  streamId: string;
  /** Monotonic per-stream sequence number. */
  sequence: number;
  /** Event type (e.g. `generation.delta`). */
  type: string;
  /** Event payload, validated against the operation's `eventSchemaId`. */
  payload: unknown;
}

/**
 * Transport abstraction: how the SDK reaches the wire endpoints. The
 * `HttpTransport` implementation talks HTTP/NDJSON; in-memory transports
 * (kernel-local, test fakes) implement the same surface.
 */
export interface Transport {
  /**
   * Perform one operation call. Resolves with a product result or a product
   * error; throws `TransportError` for transport-level failures.
   */
  call(operationId: string, payload: unknown, options: CallOptions): Promise<CallResult<unknown>>;
  /** Open an event stream for a streaming operation. */
  stream(operationId: string, payload: unknown, options: StreamOptions): AsyncIterable<StreamEvent>;
  /** Fetch raw server meta for the handshake. */
  meta(): Promise<unknown>;
}
