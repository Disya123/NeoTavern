/**
 * @neotavern/client-sdk — error model.
 *
 * Three error classes map every failure mode of a wire call onto a stable,
 * machine-readable shape:
 * - `ProductError` — the server answered with a product error envelope
 *   (`kind: 'error'`); carries the full `ProductErrorDto`.
 * - `TransportError` — the request never produced a confirmed product error:
 *   network failure, timeout, unparseable or schema-violating response,
 *   interrupted stream.
 * - `OutcomeUnknownError` — a non-idempotent operation timed out before any
 *   confirmed product error (ТЗ §15.2); the caller must not blindly retry.
 */

import type { ProductErrorDto } from './types.js';

/** Options accepted by the {@link TransportError} constructor. */
export interface TransportErrorOptions {
  message?: string;
  cause?: unknown;
  /** Whether retrying the same operation has a chance of succeeding. */
  retryable: boolean;
  /** Whether this failure is a request timeout (the outcome is unknown). */
  timeout: boolean;
  /**
   * Streams only: whether the stream can be resumed from the last received
   * sequence (recovery by sequence is a kernel-side feature; the SDK flags
   * the loss and lets the caller decide).
   */
  resumable?: boolean;
}

/** Options accepted by the {@link OutcomeUnknownError} constructor. */
export interface OutcomeUnknownErrorOptions {
  /** The operation whose outcome is unknown. */
  operationId: string;
  /** Number of transport attempts made before giving up. */
  attemptCount: number;
  cause?: unknown;
}

/**
 * A confirmed product error returned by the server inside a
 * `wire.response.envelope` error envelope. Wraps the wire `ProductErrorDto`
 * and mirrors its fields for convenient access.
 */
export class ProductError extends Error {
  /** Stable machine-readable error code (see `WIRE_ERROR_CODES`). */
  readonly code: string;
  /** Tolerant, server-supplied parameters describing the failure. */
  readonly params: Record<string, unknown>;
  /** Server-side trace identifier, when supplied. */
  readonly traceId?: string;
  /** Correlation identifier tying this error to a request, when supplied. */
  readonly correlationId?: string;

  constructor(error: ProductErrorDto) {
    super(`product error: ${error.code}`);
    this.name = 'ProductError';
    this.code = error.code;
    this.params = error.params;
    this.traceId = error.traceId;
    this.correlationId = error.correlationId;
  }
}

/**
 * A transport-level failure: network error, timeout, HTTP status without a
 * parseable error envelope, a response that violates the wire schema, or a
 * stream that died mid-way. Never a confirmed product error.
 */
export class TransportError extends Error {
  /** Whether retrying the same operation may succeed. */
  readonly retryable: boolean;
  /** Whether this failure was a request timeout (outcome unknown). */
  readonly timeout: boolean;
  /** Streams only: whether the stream may be resumed by sequence. */
  readonly resumable: boolean;

  constructor(options: TransportErrorOptions) {
    super(options.message ?? 'transport error', { cause: options.cause });
    this.name = 'TransportError';
    this.retryable = options.retryable;
    this.timeout = options.timeout;
    this.resumable = options.resumable ?? false;
  }
}

/**
 * Thrown when a non-idempotent operation times out before a confirmed
 * product error (ТЗ §15.2). The server may or may not have applied the
 * operation; the caller must query state rather than blindly retry.
 */
export class OutcomeUnknownError extends Error {
  /** The operation whose outcome is unknown. */
  readonly operationId: string;
  /** Number of transport attempts made before giving up. */
  readonly attemptCount: number;

  constructor(options: OutcomeUnknownErrorOptions) {
    super(`outcome unknown for ${options.operationId} after ${options.attemptCount} attempt(s)`, {
      cause: options.cause,
    });
    this.name = 'OutcomeUnknownError';
    this.operationId = options.operationId;
    this.attemptCount = options.attemptCount;
  }
}
