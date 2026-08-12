/**
 * @neotavern/client-sdk — typed client over the product wire protocol.
 *
 * `ClientSdk` adds operation semantics on top of a {@link Transport}:
 * registry lookup, outbound request validation and size limits, response
 * and event validation, idempotency-aware retry, and timeout handling that
 * never blindly retries a non-idempotent operation.
 */

import { Value } from '@sinclair/typebox/value';
import {
  buildProductWireRegistry,
  MetaDtoSchema,
  WIRE_PROTOCOL,
  WIRE_SCHEMAS,
  type CompiledOperation,
} from '@neotavern/contracts';
import { OutcomeUnknownError, ProductError, TransportError } from './errors.js';
import type { CallOptions, MetaDto, StreamEvent, StreamOptions, Transport } from './types.js';

/** Options for {@link ClientSdk}. */
export interface ClientSdkOptions {
  /** Transport used to reach the wire endpoints. */
  transport: Transport;
}

/**
 * Typed SDK over the product wire protocol.
 *
 * - `handshake()` validates server meta against `wire.meta.dto` and the
 *   wire protocol major.
 * - `call()` looks the operation up in the product registry, validates the
 *   outbound payload and its size before any transport request, enforces
 *   the retry policy (idempotent operations only), maps product errors to
 *   {@link ProductError} and validates the response schema.
 * - `stream()` validates the outbound payload, then validates every event
 *   payload against the operation's `eventSchemaId`. A stream that dies
 *   mid-way fails with a resumable {@link TransportError}; a terminal event
 *   is never fabricated.
 */
export class ClientSdk {
  private readonly transport: Transport;
  private readonly operations: ReadonlyMap<string, CompiledOperation>;

  constructor(options: ClientSdkOptions) {
    this.transport = options.transport;
    const registry = buildProductWireRegistry();
    this.operations = new Map(
      registry.operations.map((operation) => [operation.operationId, operation]),
    );
  }

  /** Fetch and validate server meta; rejects with `TransportError` on failure. */
  async handshake(): Promise<MetaDto> {
    const raw = await this.transport.meta();
    if (!Value.Check(MetaDtoSchema, raw)) {
      throw new TransportError({
        message: `server meta violates ${MetaDtoSchema.$id}`,
        retryable: false,
        timeout: false,
      });
    }
    if (raw.productWire.major !== WIRE_PROTOCOL.major) {
      throw new TransportError({
        message: `wire protocol major mismatch: server ${raw.productWire.major}, client ${WIRE_PROTOCOL.major}`,
        retryable: false,
        timeout: false,
      });
    }
    return raw;
  }

  /**
   * Execute one operation call.
   *
   * Throws `ProductError` for confirmed product errors, `TransportError`
   * for transport/schema failures, and `OutcomeUnknownError` when a
   * non-idempotent operation times out (or an idempotent one exhausts its
   * retries on timeouts) before a confirmed product error.
   */
  async call<T = unknown>(
    operationId: string,
    payload: unknown,
    options: CallOptions = {},
  ): Promise<T> {
    const operation = this.requireOperation(operationId);
    this.validateOutbound(operation, payload);
    // Retryable policies retry up to 2 times, but only for idempotent
    // operations: a non-idempotent operation must never be replayed.
    const maxRetries =
      operation.idempotency !== 'idempotent' || operation.retryPolicy === 'none' ? 0 : 2;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.transport.call(operationId, payload, options);
        if (!result.ok) throw new ProductError(result.error);
        return this.validateResponse(operation, result.value) as T;
      } catch (error) {
        if (error instanceof ProductError) throw error;
        if (!(error instanceof TransportError)) throw error;
        if (attempt < maxRetries && (error.retryable || error.timeout)) continue;
        if (error.timeout) {
          throw new OutcomeUnknownError({ operationId, attemptCount: attempt + 1, cause: error });
        }
        throw error;
      }
    }
  }

  /**
   * Open an event stream. Yields validated `StreamEvent`s; throws
   * `TransportError` (resumable) if the stream dies mid-way.
   */
  async *stream(
    operationId: string,
    payload: unknown,
    options: StreamOptions = {},
  ): AsyncIterable<StreamEvent> {
    const operation = this.requireOperation(operationId);
    this.validateOutbound(operation, payload);
    if (operation.eventSchemaId === undefined) {
      throw new Error(`operation ${operationId} does not stream events`);
    }
    const eventSchema = this.requireSchema(operation.eventSchemaId);
    for await (const event of this.transport.stream(operationId, payload, options)) {
      if (!Value.Check(eventSchema, event.payload)) {
        throw new TransportError({
          message: `event payload violates schema ${operation.eventSchemaId} (${operationId})`,
          retryable: false,
          timeout: false,
          resumable: true,
        });
      }
      yield event;
    }
  }

  private requireOperation(operationId: string): CompiledOperation {
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      throw new Error(`unknown operation: ${operationId}`);
    }
    return operation;
  }

  private requireSchema(schemaId: string) {
    const schema = WIRE_SCHEMAS[schemaId];
    if (schema === undefined) {
      throw new Error(`wire schema not found: ${schemaId}`);
    }
    return schema;
  }

  private validateOutbound(operation: CompiledOperation, payload: unknown): void {
    const requestSchema = this.requireSchema(operation.requestSchemaId);
    if (!Value.Check(requestSchema, payload)) {
      throw new Error(
        `payload violates request schema ${operation.requestSchemaId} (${operation.operationId})`,
      );
    }
    const size = this.jsonByteLength(payload);
    if (size > operation.requestLimitBytes) {
      throw new Error(
        `payload of ${size} bytes exceeds request limit of ${operation.requestLimitBytes} (${operation.operationId})`,
      );
    }
  }

  private validateResponse(operation: CompiledOperation, value: unknown): unknown {
    if (operation.responseSchemaId === undefined) {
      throw new TransportError({
        message: `operation ${operation.operationId} has no response schema`,
        retryable: false,
        timeout: false,
      });
    }
    const responseSchema = this.requireSchema(operation.responseSchemaId);
    if (!Value.Check(responseSchema, value)) {
      throw new TransportError({
        message: `response violates schema ${operation.responseSchemaId} (${operation.operationId})`,
        retryable: false,
        timeout: false,
      });
    }
    return value;
  }

  private jsonByteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
}
