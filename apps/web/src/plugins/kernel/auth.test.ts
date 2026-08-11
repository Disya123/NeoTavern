/**
 * Rev4 kernel auth slice (web host side): capability gates and REST
 * delegation for the OAuth connection API (rev4 §K5). Mirrors jobs.test.ts
 * fakes: no tokens ever cross the wire into the sandbox — the slice only
 * relays metadata.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import { attachAuth } from './auth.js';
import type { KernelHostContext } from './types.js';

const { KernelErrorCode } = kernel;

const CONNECTION = {
  connectionId: 'c1',
  serviceId: 'com.example.api',
  serviceName: 'Example API',
  scopes: ['profile'],
  status: 'connected',
  createdAt: 1,
  updatedAt: 2,
};

interface FakeFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function fakeContext(capabilities: ReadonlySet<string>) {
  const handlers = new Map<string, (ctx: { params: unknown }) => unknown>();
  const session = {
    handle: vi.fn((method: string, handler: (ctx: { params: unknown }) => unknown) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    scope: { track: vi.fn((item: unknown) => item) },
  };
  const ctx = {
    pluginId: 'test.auth',
    frame: {},
    session,
    runtime: {},
    hasCapability: (name: string) => capabilities.has(name),
    currentChatId: () => null,
  } as unknown as KernelHostContext;
  return { ctx, handlers, session };
}

function invoke(
  handlers: Map<string, (ctx: { params: unknown }) => unknown>,
  method: string,
  params: unknown,
) {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`no handler for ${method}`);
  return handler({ params });
}

function fetchResponse(status: number, body: unknown): FakeFetchResponse {
  return { ok: status < 400, status, json: async () => body };
}

const ROUTE_PREFIX = '/api/v2/plugins/test.auth/auth';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => fetchResponse(200, { items: [CONNECTION] }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kernel auth', () => {
  it('registers the four auth wire methods', () => {
    const fake = fakeContext(new Set());
    attachAuth(fake.ctx);
    expect([...fake.handlers.keys()].sort()).toEqual([
      'auth.connect',
      'auth.get',
      'auth.list',
      'auth.revoke',
    ]);
  });

  it('auth.list requires the auth.connections capability', async () => {
    const fake = fakeContext(new Set());
    attachAuth(fake.ctx);
    await expect(invoke(fake.handlers, 'auth.list', {})).rejects.toThrowError(
      expect.objectContaining({ code: KernelErrorCode.CAPABILITY_DENIED }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auth.list returns connection metadata from the REST route', async () => {
    const fake = fakeContext(new Set(['auth.connections']));
    attachAuth(fake.ctx);
    const result = (await invoke(fake.handlers, 'auth.list', {})) as { connections: unknown };
    expect(result.connections).toEqual([CONNECTION]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${ROUTE_PREFIX}/connections`);
    expect(init?.method).toBe('GET');
  });

  it('auth.get returns the matching connection or null', async () => {
    const fake = fakeContext(new Set(['auth.connections']));
    attachAuth(fake.ctx);
    const found = (await invoke(fake.handlers, 'auth.get', {
      connectionId: 'c1',
    })) as { connection: unknown };
    expect(found.connection).toEqual(CONNECTION);
    const missing = (await invoke(fake.handlers, 'auth.get', {
      connectionId: 'nope',
    })) as { connection: unknown };
    expect(missing.connection).toBeNull();
  });

  it('auth.get validates the connectionId parameter', async () => {
    const fake = fakeContext(new Set(['auth.connections']));
    attachAuth(fake.ctx);
    await expect(invoke(fake.handlers, 'auth.get', {})).rejects.toThrowError(
      expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auth.connect posts serviceId + scopes and returns the result', async () => {
    const fake = fakeContext(new Set(['auth.connections']));
    attachAuth(fake.ctx);
    fetchMock.mockResolvedValueOnce(
      fetchResponse(200, {
        connectionId: 'c2',
        status: 'pending',
        authorizationUrl: 'https://accounts.example.com/authorize?x=1',
      }),
    );
    const result = await invoke(fake.handlers, 'auth.connect', {
      serviceId: 'com.example.api',
      scopes: ['profile', 'read'],
    });
    expect(result).toMatchObject({ status: 'pending', connectionId: 'c2' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      serviceId: 'com.example.api',
      scopes: ['profile', 'read'],
    });
  });

  it('auth.connect rejects invalid scopes', async () => {
    const fake = fakeContext(new Set(['auth.connections']));
    attachAuth(fake.ctx);
    await expect(
      invoke(fake.handlers, 'auth.connect', { serviceId: 'x', scopes: [42] }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auth.revoke posts the connectionId', async () => {
    const fake = fakeContext(new Set(['auth.connections']));
    attachAuth(fake.ctx);
    fetchMock.mockResolvedValueOnce(fetchResponse(200, { ok: true }));
    const result = (await invoke(fake.handlers, 'auth.revoke', {
      connectionId: 'c1',
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ connectionId: 'c1' });
  });

  it('maps a 403 REST failure to CAPABILITY_DENIED', async () => {
    const fake = fakeContext(new Set(['auth.connections']));
    attachAuth(fake.ctx);
    fetchMock.mockResolvedValueOnce(
      fetchResponse(403, { code: 'PLUGIN_PERMISSION_DENIED', params: {} }),
    );
    await expect(invoke(fake.handlers, 'auth.list', {})).rejects.toThrowError(
      expect.objectContaining({ code: KernelErrorCode.CAPABILITY_DENIED }),
    );
  });

  it('maps a 404 REST failure to NOT_FOUND', async () => {
    const fake = fakeContext(new Set(['auth.connections']));
    attachAuth(fake.ctx);
    fetchMock.mockResolvedValueOnce(fetchResponse(404, { code: 'PLUGIN_NOT_FOUND', params: {} }));
    await expect(invoke(fake.handlers, 'auth.list', {})).rejects.toThrowError(
      expect.objectContaining({ code: KernelErrorCode.NOT_FOUND }),
    );
  });
});
