/**
 * Rev4 backend bridge host handlers: capability gate, path validation,
 * body-stream plumbing, abort propagation, response streaming.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import type { FrontendPluginRuntime, RuntimeFrame } from '../runtime.js';
import type { KernelHostContext } from './types.js';
import { attachBackend } from './backend.js';

const PLUGIN_ID = 'test.backend-bridge';

class FakeInboundStream {
  private chunks: Uint8Array[] = [];
  private waiters: Array<(value: Uint8Array | null) => void> = [];
  private ended = false;

  push(chunk: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(chunk);
    else this.chunks.push(chunk);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  pull(): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift();
    if (chunk !== undefined) return Promise.resolve(chunk);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface OutboundEntry {
  streamId: string;
  meta: Record<string, unknown>;
  writes: Uint8Array[];
  ended: boolean;
  failed: unknown;
}

/** Structural stand-in for KernelSession covering the surface under test. */
class FakeSession {
  readonly handlers = new Map<string, (context: kernel.RpcRequestContext) => Promise<unknown>>();
  readonly inbound = new Map<string, FakeInboundStream>();
  readonly outbound: OutboundEntry[] = [];
  private sequence = 0;

  handle(method: string, handler: kernel.RpcHandler): () => void {
    this.handlers.set(method, (context) => Promise.resolve(handler(context)));
    return () => {
      this.handlers.delete(method);
    };
  }

  getInboundStream(streamId: string): FakeInboundStream | null {
    return this.inbound.get(streamId) ?? null;
  }

  openOutboundStream(meta: Record<string, unknown>): {
    streamId: string;
    write(chunk: Uint8Array): Promise<void>;
    end(): void;
    fail(error?: unknown): void;
  } {
    this.sequence += 1;
    const entry: OutboundEntry = {
      streamId: `host:str:${this.sequence}`,
      meta,
      writes: [],
      ended: false,
      failed: null,
    };
    this.outbound.push(entry);
    return {
      streamId: entry.streamId,
      write: async (chunk) => {
        entry.writes.push(chunk);
      },
      end: () => {
        entry.ended = true;
      },
      fail: (error?: unknown) => {
        entry.failed = error ?? new kernel.KernelError(kernel.KernelErrorCode.STREAM_FAILED);
      },
    };
  }
}

function makeContext(granted: boolean): { ctx: KernelHostContext; session: FakeSession } {
  const session = new FakeSession();
  // Test double: only the session surface exercised by backend.ts is faked.
  const ctx: KernelHostContext = {
    pluginId: PLUGIN_ID,
    frame: {} as RuntimeFrame,
    session: session as unknown as kernel.KernelSession,
    runtime: {} as FrontendPluginRuntime,
    hasCapability: (name) => granted && name === 'compute.backend',
    currentChatId: () => null,
    currentProviderId: () => null,
  };
  return { ctx, session };
}

function rpc(params: unknown, signal?: AbortSignal): kernel.RpcRequestContext {
  return {
    id: 'host:req:1',
    method: 'backend.request',
    params,
    instanceId: 'test-instance',
    deadline: null,
    signal: signal ?? new AbortController().signal,
  };
}

async function kernelError(promise: Promise<unknown>): Promise<kernel.KernelError> {
  const error = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(kernel.KernelError);
  return error as kernel.KernelError;
}

function handler(
  session: FakeSession,
  method: 'backend.request' | 'backend.invoke',
): (context: kernel.RpcRequestContext) => Promise<unknown> {
  const found = session.handlers.get(method);
  expect(found).toBeDefined();
  return found!;
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('attachBackend', () => {
  it('registers backend.request and backend.invoke handlers', () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    expect(session.handlers.has('backend.request')).toBe(true);
    expect(session.handlers.has('backend.invoke')).toBe(true);
  });

  it('denies both methods without the compute.backend capability', async () => {
    const { ctx, session } = makeContext(false);
    attachBackend(ctx);

    const requestError = await kernelError(
      handler(session, 'backend.request')(rpc({ path: '/ping', method: 'GET' })),
    );
    expect(requestError.code).toBe(kernel.KernelErrorCode.CAPABILITY_DENIED);

    const invokeError = await kernelError(
      handler(session, 'backend.invoke')(rpc({ path: '/ping', input: {} })),
    );
    expect(invokeError.code).toBe(kernel.KernelErrorCode.CAPABILITY_DENIED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects paths containing traversal before any fetch', async () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    const call = handler(session, 'backend.request');

    for (const path of ['../evil', 'a/../b', '/secrets/../etc', 'x?y=1', '', 'a#b']) {
      const error = await kernelError(call(rpc({ path, method: 'GET' })));
      expect(error.code).toBe(kernel.KernelErrorCode.VALIDATION_FAILED);
      expect(error.details).toMatchObject({ field: 'path' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown methods', async () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    const error = await kernelError(
      handler(session, 'backend.request')(rpc({ path: '/ping', method: 'PATCH' })),
    );
    expect(error.code).toBe(kernel.KernelErrorCode.VALIDATION_FAILED);
    expect(error.details).toMatchObject({ field: 'method' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns streamId and status for a 200 JSON response', async () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    const body = JSON.stringify({ ok: true });
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'sid=1' },
      }),
    );

    const result = (await handler(
      session,
      'backend.request',
    )(rpc({ path: 'echo', method: 'GET' }))) as {
      status: number;
      headers: Record<string, string>;
      streamId: string;
    };

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/plugins/${PLUGIN_ID}/echo`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['set-cookie']).toBeUndefined();

    const entry = session.outbound.at(-1);
    expect(entry).toBeDefined();
    expect(result.streamId).toBe(entry!.streamId);
    expect(entry!.meta).toEqual({
      kind: 'backend.response',
      requestId: 'host:req:1',
      status: 200,
    });
    await vi.waitFor(() => expect(entry!.ended).toBe(true));
    expect(entry!.failed).toBeNull();
    const total = entry!.writes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of entry!.writes) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(new TextDecoder().decode(merged)).toBe(body);
  });

  it('drains the inbound body stream into the proxied request', async () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    const bodyStream = new FakeInboundStream();
    bodyStream.push(new TextEncoder().encode('hello '));
    bodyStream.push(new TextEncoder().encode('backend'));
    bodyStream.end();
    session.inbound.set('str:1', bodyStream);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = (await handler(
      session,
      'backend.request',
    )(rpc({ path: '/upload', method: 'POST', bodyStreamId: 'str:1' }))) as {
      status: number;
      headers: Record<string, string>;
      streamId: string;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('hello backend');
    expect(result.status).toBe(204);
    // Null response bodies still yield a stream that ends immediately.
    const entry = session.outbound.at(-1);
    expect(entry).toBeDefined();
    expect(result.streamId).toBe(entry!.streamId);
    expect(entry!.ended).toBe(true);
    expect(entry!.writes).toHaveLength(0);
  });

  it('fails the request when the inbound body exceeds 8MiB', async () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    const bodyStream = new FakeInboundStream();
    bodyStream.push(new Uint8Array(5 * 1024 * 1024));
    bodyStream.push(new Uint8Array(5 * 1024 * 1024));
    session.inbound.set('str:1', bodyStream);

    const error = await kernelError(
      handler(
        session,
        'backend.request',
      )(rpc({ path: '/upload', method: 'POST', bodyStreamId: 'str:1' })),
    );
    expect(error.code).toBe(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED);
    expect(error.details).toMatchObject({ limit: 'backend.request.maxBodyBytes' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails with NOT_FOUND when the body stream does not exist', async () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    const error = await kernelError(
      handler(
        session,
        'backend.request',
      )(rpc({ path: '/upload', method: 'POST', bodyStreamId: 'nope' })),
    );
    expect(error.code).toBe(kernel.KernelErrorCode.NOT_FOUND);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates the RPC abort signal into fetch', async () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const pending = handler(
      session,
      'backend.request',
    )(rpc({ path: '/slow', method: 'GET' }, controller.signal));
    controller.abort();
    const error = await kernelError(pending);
    expect(error.code).toBe(kernel.KernelErrorCode.OPERATION_ABORTED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it('invoke posts JSON input and returns the parsed response', async () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ answer: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await handler(
      session,
      'backend.invoke',
    )(rpc({ path: 'compute', input: { a: 1 } }));
    expect(result).toEqual({ answer: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/plugins/${PLUGIN_ID}/compute`,
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(JSON.stringify({ a: 1 }));
  });

  it('invoke rejects non-JSON responses with VALIDATION_FAILED', async () => {
    const { ctx, session } = makeContext(true);
    attachBackend(ctx);
    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    const error = await kernelError(
      handler(session, 'backend.invoke')(rpc({ path: 'compute', input: {} })),
    );
    expect(error.code).toBe(kernel.KernelErrorCode.VALIDATION_FAILED);
    expect(error.details).toMatchObject({ field: 'response', reason: 'not-json' });
  });
});
