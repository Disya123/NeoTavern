/**
 * @neotavern/client-sdk — HTTP/NDJSON transport.
 *
 * Speaks the product wire protocol over three endpoints:
 * - `POST {base}/rpc` — canonical `RequestEnvelope` in, `ResponseEnvelope` out;
 * - `POST {base}/stream` — canonical `RequestEnvelope` in, NDJSON
 *   `EventEnvelope` lines out;
 * - `GET {base}/meta` — raw server meta for the handshake.
 *
 * The transport is deliberately generic: it knows only the envelope format,
 * never operation-specific schemas. `fetch` is injectable for tests.
 */

import { Value } from '@sinclair/typebox/value';
import {
  EventEnvelopeSchema,
  ResponseEnvelopeSchema,
  WIRE_PROTOCOL,
  WIRE_SCHEMA_HASH,
} from '@neotavern/contracts';
import { TransportError } from './errors.js';
import type { CallOptions, CallResult, StreamEvent, StreamOptions, Transport } from './types.js';

/** Options for {@link HttpTransport}. */
export interface HttpTransportOptions {
  /**
   * Base URL of the wire endpoint, e.g. `http://127.0.0.1:4488`. A trailing
   * slash is normalized away.
   */
  baseUrl: string;
  /** Injectable fetch implementation (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
}

/** Structural shape of the outgoing request envelope. */
interface WireRequestEnvelope {
  wireProtocol: { major: number; minor: number };
  schemaHash: string;
  requestId: string;
  operationId: string;
  payload: unknown;
}

/**
 * HTTP transport for the product wire protocol.
 *
 * Network failures and timeouts surface as `TransportError`; a non-2xx
 * status with a parseable error envelope surfaces as a product error
 * result; a non-2xx status without one surfaces as a retryable
 * `TransportError`. Stream lines are validated against
 * `wire.event.envelope`; a broken line fails the stream with a resumable
 * `TransportError`.
 */
export class HttpTransport implements Transport {
  /** Normalized base URL (no trailing slash). */
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async meta(): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/meta`, { method: 'GET' });
    } catch (error) {
      throw new TransportError({
        message: 'meta request failed',
        retryable: true,
        timeout: false,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new TransportError({
        message: `meta request failed with status ${response.status}`,
        retryable: response.status >= 500,
        timeout: false,
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new TransportError({
        message: 'meta response was not valid JSON',
        retryable: false,
        timeout: false,
        cause: error,
      });
    }
  }

  async call(
    operationId: string,
    payload: unknown,
    options: CallOptions = {},
  ): Promise<CallResult<unknown>> {
    const response = await this.post(
      `${this.baseUrl}/rpc`,
      this.buildEnvelope(operationId, payload),
      options,
    );
    return this.parseCallResponse(response);
  }

  async *stream(
    operationId: string,
    payload: unknown,
    options: StreamOptions = {},
  ): AsyncIterable<StreamEvent> {
    const response = await this.post(
      `${this.baseUrl}/stream`,
      this.buildEnvelope(operationId, payload),
      {
        signal: options.signal,
      },
    );
    if (!response.ok) {
      throw new TransportError({
        message: `stream request failed with status ${response.status}`,
        retryable: response.status >= 500,
        timeout: false,
      });
    }
    if (response.body === null) {
      throw new TransportError({
        message: 'stream response has no body',
        retryable: false,
        timeout: false,
      });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) yield this.parseEventLine(trimmed);
        }
      }
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail.length > 0) yield this.parseEventLine(tail);
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if (options.signal?.aborted) throw error;
      throw new TransportError({
        message: 'stream connection lost mid-way',
        retryable: true,
        timeout: false,
        resumable: true,
        cause: error,
      });
    } finally {
      reader.releaseLock();
    }
  }

  private buildEnvelope(operationId: string, payload: unknown): WireRequestEnvelope {
    return {
      wireProtocol: WIRE_PROTOCOL,
      schemaHash: WIRE_SCHEMA_HASH,
      requestId: crypto.randomUUID(),
      operationId,
      payload,
    };
  }

  private async post(url: string, body: unknown, options: CallOptions): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.idempotencyKey !== undefined) {
      headers['idempotency-key'] = options.idempotencyKey;
    }
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new TransportError({
          message: `request timed out after ${options.timeoutMs}ms`,
          retryable: true,
          timeout: true,
          cause: error,
        });
      }
      if (options.signal?.aborted) {
        throw error;
      }
      throw new TransportError({
        message: 'request failed',
        retryable: true,
        timeout: false,
        cause: error,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async parseCallResponse(response: Response): Promise<CallResult<unknown>> {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TransportError({
        message: `rpc response was not valid JSON (status ${response.status})`,
        retryable: response.status >= 500,
        timeout: false,
      });
    }
    if (!Value.Check(ResponseEnvelopeSchema, parsed)) {
      throw new TransportError({
        message: `rpc response violates ${ResponseEnvelopeSchema.$id} (status ${response.status})`,
        retryable: false,
        timeout: false,
      });
    }
    if (parsed.kind === 'ok') {
      return { ok: true, value: parsed.result };
    }
    return { ok: false, error: parsed.error };
  }

  private parseEventLine(line: string): StreamEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new TransportError({
        message: 'stream line is not valid JSON',
        retryable: false,
        timeout: false,
        resumable: true,
        cause: error,
      });
    }
    if (!Value.Check(EventEnvelopeSchema, parsed)) {
      throw new TransportError({
        message: `stream event violates ${EventEnvelopeSchema.$id}`,
        retryable: false,
        timeout: false,
        resumable: true,
      });
    }
    return {
      streamId: parsed.streamId,
      sequence: parsed.sequence,
      type: parsed.type,
      payload: parsed.payload,
    };
  }
}
