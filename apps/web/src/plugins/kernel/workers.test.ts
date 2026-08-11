/**
 * Rev4 workers host handlers: capability gate, manifest allowlist, bundle
 * verification (size/MIME), quota ledger, revocation and teardown.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import type { FrontendPluginRuntime, RuntimeFrame } from '../runtime.js';
import type { KernelHostContext } from './types.js';
import { attachWorkers } from './workers.js';

const PLUGIN_ID = 'test.workers';

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
  readonly outbound: OutboundEntry[] = [];
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly revokedListeners = new Set<(name: string) => void>();
  private readonly tracked: Array<{ dispose(): void }> = [];
  private sequence = 0;

  readonly scope = {
    track: (item: { dispose(): void }): void => {
      this.tracked.push(item);
    },
  };

  handle(method: string, handler: kernel.RpcHandler): () => void {
    this.handlers.set(method, (context) => Promise.resolve(handler(context)));
    return () => {
      this.handlers.delete(method);
    };
  }

  call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return Promise.resolve({});
  }

  onCapabilityRevoked(listener: (name: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => {
      this.revokedListeners.delete(listener);
    };
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

  disposeTracked(): void {
    for (const item of this.tracked.splice(0)) item.dispose();
  }
}

function makeContext(
  granted: boolean,
  workers?: string[],
): { ctx: KernelHostContext; session: FakeSession } {
  const session = new FakeSession();
  const frame = {
    plugin: { id: PLUGIN_ID, manifest: workers ? { workers } : {} },
  } as unknown as RuntimeFrame;
  // Test double: only the session surface exercised by workers.ts is faked.
  const ctx: KernelHostContext = {
    pluginId: PLUGIN_ID,
    frame,
    session: session as unknown as kernel.KernelSession,
    runtime: {} as FrontendPluginRuntime,
    hasCapability: (name) => granted && name === 'compute.worker',
    currentChatId: () => null,
    currentProviderId: () => null,
  };
  return { ctx, session };
}

function rpc(params: unknown, signal?: AbortSignal): kernel.RpcRequestContext {
  return {
    id: 'host:req:1',
    method: 'workers.spawn',
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
  method: 'workers.spawn' | 'workers.terminate' | 'workers.exited' | 'workers.error',
): (context: kernel.RpcRequestContext) => Promise<unknown> {
  const found = session.handlers.get(method);
  expect(found).toBeDefined();
  return found!;
}

function bundleResponse(source: string, extra?: Record<string, string>): Response {
  return new Response(source, {
    status: 200,
    headers: { 'content-type': 'text/javascript', ...extra },
  });
}

const SPAWN_SOURCE = 'self.onmessage = (e) => self.postMessage({ doubled: e.data.value * 2 });';

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('attachWorkers', () => {
  it('registers the workers.* handlers', () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    for (const method of [
      'workers.spawn',
      'workers.terminate',
      'workers.exited',
      'workers.error',
    ]) {
      expect(session.handlers.has(method)).toBe(true);
    }
  });

  it('denies spawn without the compute.worker capability', async () => {
    const { ctx, session } = makeContext(false, ['workers/double.js']);
    attachWorkers(ctx);
    const error = await kernelError(
      handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' })),
    );
    expect(error.code).toBe(kernel.KernelErrorCode.CAPABILITY_DENIED);
    expect(error.details).toMatchObject({ capability: 'compute.worker' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects entries not on the manifest allowlist before any fetch', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    for (const entry of ['workers/other.mjs', 'workers/extra.js']) {
      const error = await kernelError(handler(session, 'workers.spawn')(rpc({ entry })));
      expect(error.code).toBe(kernel.KernelErrorCode.VALIDATION_FAILED);
      expect(error.details).toMatchObject({ reason: 'not-in-manifest-workers' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a plugin whose manifest declares no workers', async () => {
    const { ctx, session } = makeContext(true);
    attachWorkers(ctx);
    const error = await kernelError(
      handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' })),
    );
    expect(error.code).toBe(kernel.KernelErrorCode.VALIDATION_FAILED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed entry params before any fetch', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    for (const params of [{}, { entry: '' }, { entry: 42 }, { entry: null }]) {
      const error = await kernelError(handler(session, 'workers.spawn')(rpc(params)));
      expect(error.code).toBe(kernel.KernelErrorCode.VALIDATION_FAILED);
      expect(error.details).toMatchObject({ field: 'entry' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams a verified bundle to the sandbox and reports the workerId', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    fetchMock.mockResolvedValueOnce(bundleResponse(SPAWN_SOURCE));

    const result = (await handler(
      session,
      'workers.spawn',
    )(rpc({ entry: 'workers/double.js' }))) as { workerId: string; streamId: string };

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v2/plugins/${PLUGIN_ID}/assets/workers/double.js`,
      expect.objectContaining({}),
    );
    const entry = session.outbound.at(-1);
    expect(entry).toBeDefined();
    expect(entry!.meta).toEqual({ kind: 'workers.bundle', entry: 'workers/double.js' });
    expect(entry!.ended).toBe(true);
    expect(entry!.failed).toBeNull();
    const merged = new Uint8Array(entry!.writes.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of entry!.writes) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(new TextDecoder().decode(merged)).toBe(SPAWN_SOURCE);
    expect(result.workerId).toBe(entry!.streamId);
    expect(result.streamId).toBe(entry!.streamId);
  });

  it('rejects non-JavaScript bundles with VALIDATION_FAILED', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    fetchMock.mockResolvedValueOnce(
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const error = await kernelError(
      handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' })),
    );
    expect(error.code).toBe(kernel.KernelErrorCode.VALIDATION_FAILED);
    expect(error.details).toMatchObject({ reason: 'bad-mime' });
    expect(session.outbound).toHaveLength(0);
  });

  it('maps a missing bundle to NOT_FOUND', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const error = await kernelError(
      handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' })),
    );
    expect(error.code).toBe(kernel.KernelErrorCode.NOT_FOUND);
  });

  it('enforces the 2MiB bundle cap from headers and body', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    fetchMock.mockResolvedValueOnce(
      bundleResponse('x'.repeat(1024), { 'content-length': String(3 * 1024 * 1024) }),
    );
    const headerError = await kernelError(
      handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' })),
    );
    expect(headerError.code).toBe(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED);
    expect(headerError.details).toMatchObject({ limit: 'workers.maxBundleBytes' });

    fetchMock.mockResolvedValueOnce(bundleResponse('x'.repeat(3 * 1024 * 1024)));
    const bodyError = await kernelError(
      handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' })),
    );
    expect(bodyError.code).toBe(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED);
    expect(session.outbound).toHaveLength(0);
  });

  it('caps .mjs bundles at the data: URL limit', async () => {
    const { ctx, session } = makeContext(true, ['workers/triple.mjs']);
    attachWorkers(ctx);
    // 1.6 MiB is under the 2 MiB blob cap but over the 1.5 MiB module cap.
    fetchMock.mockResolvedValueOnce(bundleResponse('x'.repeat(Math.ceil(1.6 * 1024 * 1024))));
    const error = await kernelError(
      handler(session, 'workers.spawn')(rpc({ entry: 'workers/triple.mjs' })),
    );
    expect(error.code).toBe(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED);
    expect(error.details).toMatchObject({ limit: 'workers.maxModuleDataUrlBytes' });
    expect(session.outbound).toHaveLength(0);
  });
  it('caps live workers at the default quota and frees slots on exit', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    const spawn = handler(session, 'workers.spawn');
    fetchMock.mockImplementation(() => bundleResponse(SPAWN_SOURCE));

    const max = kernel.DEFAULT_PLUGIN_LIMITS.workers.maxInstances;
    for (let i = 0; i < max; i += 1) {
      await spawn(rpc({ entry: 'workers/double.js' }));
    }
    const over = await kernelError(spawn(rpc({ entry: 'workers/double.js' })));
    expect(over.code).toBe(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED);
    expect(over.details).toMatchObject({ limit: 'workers.maxInstances' });

    // The sandbox reports the first worker's exit; the slot opens up.
    const first = session.outbound[0]!.streamId;
    await handler(session, 'workers.exited')(rpc({ workerId: first }));
    const again = await spawn(rpc({ entry: 'workers/double.js' }));
    expect(again).toMatchObject({ workerId: expect.any(String) });
  });

  it('workers.error also frees the quota slot', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    const spawn = handler(session, 'workers.spawn');
    fetchMock.mockImplementation(() => bundleResponse(SPAWN_SOURCE));
    const max = kernel.DEFAULT_PLUGIN_LIMITS.workers.maxInstances;
    const ids: string[] = [];
    for (let i = 0; i < max; i += 1) {
      const result = (await spawn(rpc({ entry: 'workers/double.js' }))) as { workerId: string };
      ids.push(result.workerId);
    }
    await handler(session, 'workers.error')(rpc({ workerId: ids[0], message: 'boom' }));
    const again = await spawn(rpc({ entry: 'workers/double.js' }));
    expect(again).toMatchObject({ workerId: expect.any(String) });
  });

  it('workers.terminate drops the ledger entry', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    fetchMock.mockResolvedValueOnce(bundleResponse(SPAWN_SOURCE));
    const result = (await handler(
      session,
      'workers.spawn',
    )(rpc({ entry: 'workers/double.js' }))) as { workerId: string };
    await handler(session, 'workers.terminate')(rpc({ workerId: result.workerId }));

    // Both slots are free again.
    fetchMock.mockImplementation(() => bundleResponse(SPAWN_SOURCE));
    for (let i = 0; i < kernel.DEFAULT_PLUGIN_LIMITS.workers.maxInstances; i += 1) {
      await handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' }));
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('session teardown terminates every live worker', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    fetchMock.mockImplementation(() => bundleResponse(SPAWN_SOURCE));
    await handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' }));
    await handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' }));

    session.disposeTracked();
    const terminates = session.calls.filter((call) => call.method === 'workers.terminate');
    expect(terminates).toHaveLength(2);
    for (const entry of session.outbound) {
      expect(
        terminates.some(
          (call) => (call.params as { workerId: string }).workerId === entry.streamId,
        ),
      ).toBe(true);
    }
  });

  it('compute.worker revocation terminates live workers', async () => {
    const { ctx, session } = makeContext(true, ['workers/double.js']);
    attachWorkers(ctx);
    fetchMock.mockResolvedValueOnce(bundleResponse(SPAWN_SOURCE));
    await handler(session, 'workers.spawn')(rpc({ entry: 'workers/double.js' }));

    for (const listener of [...session.revokedListeners]) listener('compute.worker');
    const terminates = session.calls.filter((call) => call.method === 'workers.terminate');
    expect(terminates).toHaveLength(1);

    // Unrelated revocations leave workers alone.
    session.calls.length = 0;
    for (const listener of [...session.revokedListeners]) listener('chats.read');
    expect(session.calls).toHaveLength(0);
  });
});
