/**
 * Rev4 kernel: backend.request + backend.invoke host handlers (contract §2).
 *
 * The sandbox never talks to its backend plugin directly; the host proxies
 * same-origin `/api/plugins/:pluginId/*` (BackendPluginHost dispatcher) and
 * shuttles the bytes over kernel streams:
 *   - request body: plugin→host stream (meta kind 'backend.body'), drained
 *     by the host into the proxied fetch;
 *   - response body: host→plugin stream (meta kind 'backend.response',
 *     requestId + HTTP status) pumped from the fetch body.
 * `backend.invoke` is the JSON convenience layer on top of the same routes.
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

/** Request bodies are buffered fully before the proxied fetch (rev4 §M2). */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Total response bytes streamed back to the plugin per request. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** JSON convenience cap for backend.invoke payloads and responses. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

/** The dispatcher only registers these methods (backendHost.registerDispatcher). */
const REQUEST_METHODS: Record<string, true> = { GET: true, POST: true, PUT: true, DELETE: true };
/** Headers the host never forwards — session/origin auth is host-controlled. */
const FORBIDDEN_REQUEST_HEADERS: Record<string, true> = {
  cookie: true,
  authorization: true,
  'proxy-authorization': true,
};
/** Headers never echoed back to the plugin (transport-only or framing). */
const FORBIDDEN_RESPONSE_HEADERS: Record<string, true> = {
  'set-cookie': true,
  'content-encoding': true,
  'transfer-encoding': true,
  'content-length': true,
  connection: true,
};
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/;

function fail(code: string, details: Record<string, unknown>): never {
  throw new kernel.KernelError(code, { details });
}

function abortError(): kernel.KernelError {
  return new kernel.KernelError(kernel.KernelErrorCode.OPERATION_ABORTED);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, { field, reason: 'not-an-object' });
  }
  return value as Record<string, unknown>;
}

/**
 * Contract §2: paths are plugin-local route tails under the plugin's own
 * REST namespace. `..` is rejected outright and the tail is pinned below
 * `/api/plugins/:pluginId/`, so the plugin can never escape its namespace.
 */
function safePluginPath(value: unknown, pluginId: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, { field: 'path', reason: 'empty' });
  }
  if (value.includes('..')) {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, { field: 'path', reason: 'path-traversal' });
  }
  if (value.includes('?') || value.includes('#') || value.includes('\\')) {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, {
      field: 'path',
      reason: 'invalid-characters',
    });
  }
  const raw = value.startsWith('/') ? value.slice(1) : value;
  const tail = raw
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/api/plugins/${encodeURIComponent(pluginId)}/${tail}`;
}

function safeMethod(value: unknown, fallback: string): string {
  const method = value ?? fallback;
  if (typeof method !== 'string' || !REQUEST_METHODS[method.toUpperCase()]) {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, {
      field: 'method',
      method,
      allowed: Object.keys(REQUEST_METHODS),
    });
  }
  return method.toUpperCase();
}

function safeHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, 'headers');
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(record)) {
    if (!HEADER_NAME.test(name)) {
      fail(kernel.KernelErrorCode.VALIDATION_FAILED, { field: 'headers', name });
    }
    if (typeof raw !== 'string') {
      fail(kernel.KernelErrorCode.VALIDATION_FAILED, {
        field: 'headers',
        name,
        reason: 'not-a-string',
      });
    }
    if (FORBIDDEN_REQUEST_HEADERS[name.toLowerCase()]) continue;
    result[name] = raw;
  }
  return result;
}

function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (FORBIDDEN_RESPONSE_HEADERS[name.toLowerCase()]) return;
    result[name] = value;
  });
  return result;
}

function mergeChunks(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Drain a plugin→host body stream into one buffer (rev4 §M2: bounded at
 * MAX_BODY_BYTES). Abort cancels the wait deterministically via a race.
 */
async function collectRequestBody(
  ctx: KernelHostContext,
  streamId: string,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = ctx.session.getInboundStream(streamId);
  if (!stream) {
    fail(kernel.KernelErrorCode.NOT_FOUND, { field: 'bodyStreamId', streamId });
  }
  const { promise: aborted, reject: rejectAborted } = Promise.withResolvers<never>();
  const onAbort = (): void => rejectAborted(abortError());
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await Promise.race([stream.pull(), aborted]);
      if (chunk === null) break;
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        fail(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
          limit: 'backend.request.maxBodyBytes',
          max: MAX_BODY_BYTES,
        });
      }
      chunks.push(chunk);
    }
    return mergeChunks(chunks, total);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Open the host→plugin response stream and pump the fetch body into it in
 * the background: the RPC resolves with `{status, headers, streamId}` up
 * front (contract §2), quota/abort failures land on the stream itself
 * (PLUGIN_QUOTA_EXCEEDED / OPERATION_ABORTED, rev4 §M2).
 */
function pumpResponse(
  ctx: KernelHostContext,
  requestId: string,
  status: number,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): string {
  const outbound = ctx.session.openOutboundStream({
    kind: 'backend.response',
    requestId,
    status,
  });
  if (!body) {
    outbound.end();
    return outbound.streamId;
  }
  void (async () => {
    const reader = body.getReader();
    const onAbort = (): void => outbound.fail(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (signal.aborted) throw abortError();
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          throw new kernel.KernelError(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
            details: { limit: 'backend.response.maxBytes', max: MAX_RESPONSE_BYTES },
          });
        }
        await outbound.write(value);
      }
      if (signal.aborted) throw abortError();
      outbound.end();
    } catch (error) {
      outbound.fail(error ?? undefined);
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        reader.releaseLock();
      } catch {
        // Already released after cancel().
      }
    }
  })();
  return outbound.streamId;
}

async function handleBackendRequest(
  ctx: KernelHostContext,
  request: kernel.RpcRequestContext,
): Promise<{ status: number; headers: Record<string, string>; streamId: string }> {
  if (!ctx.hasCapability('compute.backend')) {
    fail(kernel.KernelErrorCode.CAPABILITY_DENIED, { capability: 'compute.backend' });
  }
  const params = asRecord(request.params, 'params');
  const url = safePluginPath(params['path'], ctx.pluginId);
  const method = safeMethod(params['method'], 'GET');
  const headers = safeHeaders(params['headers']);
  let body: Uint8Array<ArrayBuffer> | undefined;
  const bodyStreamId = params['bodyStreamId'];
  if (bodyStreamId !== undefined) {
    if (typeof bodyStreamId !== 'string' || bodyStreamId.length === 0) {
      fail(kernel.KernelErrorCode.VALIDATION_FAILED, { field: 'bodyStreamId' });
    }
    body = await collectRequestBody(ctx, bodyStreamId, request.signal);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: request.signal,
      // Same-origin app session; the plugin never sees the credentials.
      credentials: 'include',
    });
  } catch (error) {
    if (request.signal.aborted) throw abortError();
    fail(kernel.KernelErrorCode.BACKEND_UNAVAILABLE, {
      reason: 'fetch-failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const streamId = pumpResponse(ctx, request.id, response.status, response.body, request.signal);
  return { status: response.status, headers: sanitizeResponseHeaders(response.headers), streamId };
}

async function handleBackendInvoke(
  ctx: KernelHostContext,
  request: kernel.RpcRequestContext,
): Promise<unknown> {
  if (!ctx.hasCapability('compute.backend')) {
    fail(kernel.KernelErrorCode.CAPABILITY_DENIED, { capability: 'compute.backend' });
  }
  const params = asRecord(request.params, 'params');
  const url = safePluginPath(params['path'], ctx.pluginId);
  const method = safeMethod(params['method'], 'POST');
  let serialized: string;
  try {
    serialized = JSON.stringify(params['input']);
  } catch (error) {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, {
      field: 'input',
      reason: 'not-json-serializable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (typeof serialized !== 'string') {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, {
      field: 'input',
      reason: 'not-json-serializable',
    });
  }
  const payload = new TextEncoder().encode(serialized);
  if (payload.byteLength > MAX_JSON_BYTES) {
    fail(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
      limit: 'backend.invoke.maxJsonBytes',
      max: MAX_JSON_BYTES,
    });
  }
  if (params['stream'] !== undefined && typeof params['stream'] !== 'boolean') {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, { field: 'stream', reason: 'not-a-boolean' });
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: request.signal,
      credentials: 'include',
    });
  } catch (error) {
    if (request.signal.aborted) throw abortError();
    fail(kernel.KernelErrorCode.BACKEND_UNAVAILABLE, {
      reason: 'fetch-failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (params['stream'] === true) {
    // Byte-stream mode (rev4 §D): same validation as above, but the body is
    // not buffered — it is pumped to the plugin over a kernel stream, and
    // the RPC settles up front with {status, headers, streamId}.
    const streamId = pumpResponse(ctx, request.id, response.status, response.body, request.signal);
    return {
      status: response.status,
      headers: sanitizeResponseHeaders(response.headers),
      streamId,
    };
  }
  const received = await readCapped(
    response,
    MAX_JSON_BYTES,
    'backend.invoke.maxJsonBytes',
    request.signal,
  );
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(received);
  } catch {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, { field: 'response', reason: 'not-utf8' });
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(kernel.KernelErrorCode.VALIDATION_FAILED, { field: 'response', reason: 'not-json' });
  }
}

/** Read a fetch response body with a total-byte cap, honoring abort. */
async function readCapped(
  response: Response,
  maxBytes: number,
  limit: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const { promise: aborted, reject: rejectAborted } = Promise.withResolvers<never>();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
    rejectAborted(abortError());
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        fail(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, { limit, max: maxBytes });
      }
      chunks.push(value);
    }
    return mergeChunks(chunks, total);
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export function attachBackend(ctx: KernelHostContext): void {
  ctx.session.handle('backend.request', (request) => handleBackendRequest(ctx, request));
  ctx.session.handle('backend.invoke', (request) => handleBackendInvoke(ctx, request));
}
