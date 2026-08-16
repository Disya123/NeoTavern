/**
 * @neotavern/client-sdk — HTTP transport for the product wire protocol.
 *
 * Speaks the wire over three endpoints (remote-http / Headless / Desktop
 * Remote Access):
 * - `POST {base}/rpc` — canonical `RequestEnvelope` in, `ResponseEnvelope` out;
 * - `POST {base}/rpc/stream` — canonical `RequestEnvelope` in, SSE
 *   (`text/event-stream`) `EventEnvelope` frames out;
 * - `GET {base}/meta` — raw server meta for the handshake.
 *
 * NDJSON on `POST {base}/stream` is still accepted when a stub/test server
 * returns `application/x-ndjson` (or any non-SSE body) so existing fixtures
 * keep working. Production Headless speaks SSE only.
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
  /**
   * Optional pairing bearer. A bare token is sent as `Authorization: Bearer
   * <token>`; a value that already starts with `Bearer ` is sent as-is.
   */
  authorization?: string;
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

interface PostOptions extends CallOptions {
  /** Override the Accept header (SSE streams send `text/event-stream`). */
  accept?: string;
}

/**
 * HTTP transport for the product wire protocol.
 *
 * Network failures and timeouts surface as `TransportError`; a non-2xx
 * status with a parseable error envelope surfaces as a product error
 * result; a non-2xx status without one surfaces as a retryable
 * `TransportError`. Stream frames are validated against
 * `wire.event.envelope`; a broken frame fails the stream with a resumable
 * `TransportError`.
 */
export class HttpTransport implements Transport {
  /** Normalized base URL (no trailing slash). */
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authorizationHeader: string | undefined;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    // Native `window.fetch` is a method: `const f = fetch; f()` throws
    // `Illegal invocation` in Chromium. Call it as `globalThis.fetch(...)`.
    // Injected test stubs are ordinary functions and are invoked unbound.
    const injected = options.fetchImpl;
    this.fetchImpl = injected
      ? (input, init) => injected(input, init)
      : (input, init) => globalThis.fetch(input, init);
    this.authorizationHeader = normalizeAuthorization(options.authorization);
  }

  async meta(): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/meta`, {
        method: 'GET',
        headers: this.headers(),
      });
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
      `${this.baseUrl}/rpc/stream`,
      this.buildEnvelope(operationId, payload),
      {
        signal: options.signal,
        accept: 'text/event-stream',
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
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      yield* this.readSse(response, options);
      return;
    }
    yield* this.readNdjson(response, options);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.authorizationHeader !== undefined) {
      headers['authorization'] = this.authorizationHeader;
    }
    return headers;
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

  private async post(url: string, body: unknown, options: PostOptions): Promise<Response> {
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
    const headers = this.headers({ 'content-type': 'application/json' });
    if (options.accept !== undefined) {
      headers['accept'] = options.accept;
    }
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

  private async *readNdjson(
    response: Response,
    options: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new TransportError({
        message: 'stream response has no body',
        retryable: false,
        timeout: false,
      });
    }
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

  private async *readSse(response: Response, options: StreamOptions): AsyncIterable<StreamEvent> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new TransportError({
        message: 'stream response has no body',
        retryable: false,
        timeout: false,
      });
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const split = splitSseFrames(buffer);
        buffer = split.rest;
        for (const frame of split.complete) {
          const event = this.parseSseFrame(frame);
          if (event !== null) yield event;
        }
      }
      buffer += decoder.decode();
      const split = splitSseFrames(`${buffer}\n\n`);
      for (const frame of split.complete) {
        const event = this.parseSseFrame(frame);
        if (event !== null) yield event;
      }
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

  private parseSseFrame(frame: string): StreamEvent | null {
    const dataLines: string[] = [];
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.replace(/\r$/u, '');
      if (line.length === 0 || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        let value = line.slice('data:'.length);
        if (value.startsWith(' ')) value = value.slice(1);
        dataLines.push(value);
      }
    }
    if (dataLines.length === 0) return null;
    return this.parseEventLine(dataLines.join('\n'));
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

function normalizeAuthorization(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.startsWith('Bearer ') ? value : `Bearer ${value}`;
}

function splitSseFrames(buffer: string): { complete: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  return {
    complete: parts.filter((part) => part.trim().length > 0),
    rest,
  };
}
