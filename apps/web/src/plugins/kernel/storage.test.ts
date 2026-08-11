/**
 * Unit tests for the storage kernel host handlers (kernel/storage.ts) against
 * a fake KernelHostContext: capability gates fire per scope, scope→ownerId
 * mapping lands in the REST query, CAS conflicts surface as REVISION_CONFLICT
 * and blob transfers stream through the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import type { RuntimeFrame } from '../runtime.js';
import { attachStorage } from './storage.js';
import type { KernelHostContext } from './types.js';

interface FakeOutbound {
  streamId: string;
  write: (chunk: Uint8Array) => Promise<void>;
  end: () => void;
  fail: (error?: unknown) => void;
  writes: Uint8Array[];
  meta: Record<string, unknown>;
}

interface FakeRpcContext {
  params: unknown;
  signal: AbortSignal;
}

interface FakeSession {
  handle: (method: string, handler: (ctx: FakeRpcContext) => Promise<unknown>) => () => void;
  getInboundStream: (streamId: string) => { pull: () => Promise<Uint8Array | null> } | null;
  openOutboundStream: (meta: Record<string, unknown>) => FakeOutbound;
  handlers: Map<string, (ctx: FakeRpcContext) => Promise<unknown>>;
  outbounds: FakeOutbound[];
  inboundStreams: Map<string, Uint8Array[]>;
}

function makeSession(): FakeSession {
  const session: FakeSession = {
    handlers: new Map(),
    outbounds: [],
    inboundStreams: new Map(),
    handle(method, handler) {
      session.handlers.set(method, handler);
      return () => session.handlers.delete(method);
    },
    getInboundStream(streamId) {
      const chunks = session.inboundStreams.get(streamId);
      if (!chunks) return null;
      let index = 0;
      return { pull: async () => (index < chunks.length ? chunks[index++]! : null) };
    },
    openOutboundStream(meta) {
      const outbound: FakeOutbound = {
        streamId: `host:str:${session.outbounds.length + 1}`,
        writes: [],
        meta,
        write: async (chunk) => {
          outbound.writes.push(chunk);
        },
        end: () => undefined,
        fail: () => undefined,
      };
      session.outbounds.push(outbound);
      return outbound;
    },
  };
  return session;
}

function makeContext(options: { capabilities?: string[]; chatId?: string | null } = {}) {
  const session = makeSession();
  const capabilities = new Set(options.capabilities ?? []);
  const capabilityChecks: Array<{ name: string; granted: boolean }> = [];
  const ctx: KernelHostContext = {
    pluginId: 'plugin.test',
    frame: {} as unknown as RuntimeFrame,
    session: session as unknown as kernel.KernelSession,
    runtime: {} as unknown as KernelHostContext['runtime'],
    hasCapability: (name) => {
      const granted = capabilities.has(name);
      capabilityChecks.push({ name, granted });
      return granted;
    },
    currentChatId: () => options.chatId ?? null,
    currentProviderId: () => null,
  };
  return { ctx, session, capabilities, capabilityChecks };
}

async function callHandler(
  session: FakeSession,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const handler = session.handlers.get(method);
  expect(handler, `handler registered for ${method}`).toBeTruthy();
  const controller = new AbortController();
  return handler!({ params, signal: controller.signal });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('attachStorage capability gates', () => {
  it('registers every storage.kv/blobs method from contract §2', () => {
    const { ctx, session } = makeContext();
    attachStorage(ctx);
    for (const method of [
      'storage.kv.get',
      'storage.kv.set',
      'storage.kv.delete',
      'storage.kv.list',
      'storage.blobs.put',
      'storage.blobs.get',
      'storage.blobs.list',
      'storage.blobs.delete',
    ]) {
      expect(session.handlers.has(method), method).toBe(true);
    }
  });

  it('denies each kv scope with CAPABILITY_DENIED and never hits the network', async () => {
    const { ctx, session, capabilityChecks } = makeContext({ capabilities: [] });
    attachStorage(ctx);
    for (const scope of ['installation', 'user', 'workspace', 'chat']) {
      await expect(
        callHandler(session, 'storage.kv.get', { scope, key: 'k' }),
      ).rejects.toMatchObject({ code: kernel.KernelErrorCode.CAPABILITY_DENIED });
    }
    expect(capabilityChecks.map((check) => check.name)).toEqual([
      'storage.installation',
      'storage.user',
      'storage.workspace',
      'storage.chat',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies blob methods with CAPABILITY_DENIED for storage.blobs', async () => {
    const { ctx, session } = makeContext({ capabilities: ['storage.user'] });
    attachStorage(ctx);
    await expect(callHandler(session, 'storage.blobs.list', {})).rejects.toMatchObject({
      code: kernel.KernelErrorCode.CAPABILITY_DENIED,
      details: { capability: 'storage.blobs' },
    });
    await expect(
      callHandler(session, 'storage.blobs.delete', { blobId: 'b' }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.CAPABILITY_DENIED });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('attachStorage scope → ownerId mapping', () => {
  it('maps installation/user to null ownerId and workspace to "workspace"', async () => {
    const { ctx, session } = makeContext({
      capabilities: ['storage.installation', 'storage.user', 'storage.workspace'],
    });
    attachStorage(ctx);
    fetchMock.mockImplementation(async () =>
      jsonResponse({ scope: 'user', ownerId: null, revision: 1, schemaVersion: 1, data: {} }),
    );

    await callHandler(session, 'storage.kv.get', { scope: 'installation', key: 'k' });
    await callHandler(session, 'storage.kv.get', { scope: 'user', key: 'k' });
    await callHandler(session, 'storage.kv.get', { scope: 'workspace', key: 'k' });

    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls).toEqual([
      '/api/v2/plugins/plugin.test/state?scope=installation',
      '/api/v2/plugins/plugin.test/state?scope=user',
      '/api/v2/plugins/plugin.test/state?scope=workspace&ownerId=workspace',
    ]);
  });

  it('maps chat scope to the current chat id and NOT_FOUND without one', async () => {
    const withChat = makeContext({ capabilities: ['storage.chat'], chatId: 'chat-42' });
    attachStorage(withChat.ctx);
    fetchMock.mockImplementation(async () =>
      jsonResponse({ scope: 'chat', ownerId: 'chat-42', revision: 1, schemaVersion: 1, data: {} }),
    );
    await callHandler(withChat.session, 'storage.kv.get', { scope: 'chat', key: 'k' });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/v2/plugins/plugin.test/state?scope=chat&ownerId=chat-42',
    );

    const noChat = makeContext({ capabilities: ['storage.chat'], chatId: null });
    attachStorage(noChat.ctx);
    await expect(
      callHandler(noChat.session, 'storage.kv.get', { scope: 'chat', key: 'k' }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.NOT_FOUND });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the with-chat call hit fetch
  });
});

describe('attachStorage kv semantics', () => {
  it('merges values into the whole-object row and guards with expectedRevision', async () => {
    const { ctx, session } = makeContext({ capabilities: ['storage.user'] });
    fetchMock.mockResolvedValue(
      jsonResponse({ scope: 'user', ownerId: null, revision: 1, schemaVersion: 1, data: {} }),
    );
    attachStorage(ctx);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ scope: 'user', ownerId: null, revision: 5, schemaVersion: 1, data: { a: 1 } }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ revision: 6 }));

    const result = await callHandler(session, 'storage.kv.set', {
      scope: 'user',
      key: 'b',
      value: 2,
    });
    expect(result).toEqual({ revision: 6 });

    const putCall = fetchMock.mock.calls[1]!;
    expect(putCall[0]).toBe('/api/v2/plugins/plugin.test/state?scope=user');
    const init = putCall[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ data: { a: 1, b: 2 }, expectedRevision: 5 });
  });

  it('honors an explicit expectedRevision and surfaces CONFLICT as REVISION_CONFLICT', async () => {
    const { ctx, session } = makeContext({ capabilities: ['storage.user'] });
    attachStorage(ctx);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ scope: 'user', ownerId: null, revision: 5, schemaVersion: 1, data: { a: 1 } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'CONFLICT', params: { expectedRevision: 3, revision: 5 } }, 409),
    );

    await expect(
      callHandler(session, 'storage.kv.set', {
        scope: 'user',
        key: 'b',
        value: 2,
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.REVISION_CONFLICT,
      details: expect.objectContaining({ code: 'CONFLICT', httpStatus: 409 }),
    });
  });

  it('returns revision 0 and null value when the store is empty', async () => {
    const { ctx, session } = makeContext({ capabilities: ['storage.user'] });
    attachStorage(ctx);
    fetchMock.mockImplementation(async () => jsonResponse({ code: 'NOT_FOUND' }, 404));

    expect(await callHandler(session, 'storage.kv.get', { scope: 'user', key: 'k' })).toEqual({
      value: null,
      revision: 0,
    });
    expect(await callHandler(session, 'storage.kv.list', { scope: 'user' })).toEqual({
      keys: [],
      revision: 0,
    });
  });

  it('deletes a key by rewriting the object at its current revision', async () => {
    const { ctx, session } = makeContext({ capabilities: ['storage.user'] });
    attachStorage(ctx);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        scope: 'user',
        ownerId: null,
        revision: 9,
        schemaVersion: 1,
        data: { a: 1, b: 2 },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ revision: 10 }));

    const result = await callHandler(session, 'storage.kv.delete', { scope: 'user', key: 'a' });
    expect(result).toEqual({ deleted: true, revision: 10 });
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      data: { b: 2 },
      expectedRevision: 9,
    });
  });
});

describe('attachStorage blobs', () => {
  it('drains the plugin→host stream and uploads it with name + contentType', async () => {
    const { ctx, session } = makeContext({ capabilities: ['storage.blobs'] });
    attachStorage(ctx);
    session.inboundStreams.set('plugin:str:1', [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ blobId: 'abc', hash: 'abc', size: 5 }));

    const result = await callHandler(session, 'storage.blobs.put', {
      streamId: 'plugin:str:1',
      name: 'file.bin',
      contentType: 'application/octet-stream',
      size: 5,
    });
    expect(result).toEqual({ blobId: 'abc', hash: 'abc', size: 5 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/v2/plugins/plugin.test/blobs?');
    expect(String(url)).toContain('name=file.bin');
    expect(String(url)).toContain('contentType=application%2Foctet-stream');
    expect((init as RequestInit).method).toBe('POST');
    expect(Array.from((init as RequestInit).body as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it('caps inbound blob uploads at 8 MiB with PLUGIN_QUOTA_EXCEEDED', async () => {
    const { ctx, session } = makeContext({ capabilities: ['storage.blobs'] });
    attachStorage(ctx);
    session.inboundStreams.set('plugin:str:big', [new Uint8Array(8 * 1024 * 1024 + 1)]);

    await expect(
      callHandler(session, 'storage.blobs.put', {
        streamId: 'plugin:str:big',
        name: 'big.bin',
        contentType: 'application/octet-stream',
      }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams blob bytes host→plugin and reports streamId/contentType/size', async () => {
    const { ctx, session } = makeContext({ capabilities: ['storage.blobs'] });
    attachStorage(ctx);
    const bytes = new Uint8Array(300 * 1024); // spans two 256 KiB chunks
    bytes[0] = 7;
    bytes[bytes.byteLength - 1] = 9;
    fetchMock.mockResolvedValueOnce(
      new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );

    const result = (await callHandler(session, 'storage.blobs.get', { blobId: 'deadbeef' })) as {
      streamId: string;
      contentType: string;
      size: number;
    };
    expect(result.contentType).toBe('image/png');
    expect(result.size).toBe(bytes.byteLength);

    const outbound = session.outbounds[0]!;
    expect(result.streamId).toBe(outbound.streamId);
    expect(outbound.meta).toMatchObject({
      kind: 'blobs.get',
      blobId: 'deadbeef',
      contentType: 'image/png',
    });
    const received = new Uint8Array(
      outbound.writes.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    let offset = 0;
    for (const chunk of outbound.writes) {
      received.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(received[0]).toBe(7);
    expect(received[received.byteLength - 1]).toBe(9);
    expect(received.byteLength).toBe(bytes.byteLength);
  });

  it('surfaces blob REST errors as NOT_FOUND kernel errors', async () => {
    const { ctx, session } = makeContext({ capabilities: ['storage.blobs'] });
    attachStorage(ctx);
    fetchMock.mockImplementation(async () => jsonResponse({ code: 'FILE_NOT_FOUND' }, 404));

    await expect(
      callHandler(session, 'storage.blobs.get', { blobId: 'missing' }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.NOT_FOUND });
    await expect(
      callHandler(session, 'storage.blobs.delete', { blobId: 'missing' }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.NOT_FOUND });
  });
});
