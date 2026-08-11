/**
 * Unit tests for the models kernel host handler (kernel/models.ts) against
 * a fake KernelHostContext: the models.list grant gates the call, an omitted
 * providerId falls back to the active provider, server errors map onto
 * stable wire codes, and the response is capped at MODELS_MAX_LIST.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import type { RuntimeFrame } from '../runtime.js';
import { attachModels } from './models.js';
import type { KernelHostContext } from './types.js';

interface FakeRpcContext {
  params: unknown;
  signal: AbortSignal;
}

interface FakeSession {
  handle: (method: string, handler: (ctx: FakeRpcContext) => Promise<unknown>) => () => void;
  handlers: Map<string, (ctx: FakeRpcContext) => Promise<unknown>>;
}

function makeSession(): FakeSession {
  const session: FakeSession = {
    handlers: new Map(),
    handle(method, handler) {
      session.handlers.set(method, handler);
      return () => session.handlers.delete(method);
    },
  };
  return session;
}

function makeContext(options: { capabilities?: string[]; providerId?: string | null } = {}) {
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
    currentChatId: () => null,
    currentProviderId: () => options.providerId ?? null,
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

describe('attachModels', () => {
  it('registers models.list from contract §2', () => {
    const { ctx, session } = makeContext();
    attachModels(ctx);
    expect(session.handlers.has('models.list')).toBe(true);
  });

  it('denies the call with CAPABILITY_DENIED without the models.list grant', async () => {
    const { ctx, session, capabilityChecks } = makeContext({ capabilities: [] });
    attachModels(ctx);
    await expect(callHandler(session, 'models.list', {})).rejects.toMatchObject({
      code: kernel.KernelErrorCode.CAPABILITY_DENIED,
      details: { capability: 'models.list' },
    });
    expect(capabilityChecks.map((check) => check.name)).toEqual(['models.list']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the provider models for an explicit providerId', async () => {
    const { ctx, session } = makeContext({ capabilities: ['models.list'] });
    attachModels(ctx);
    fetchMock.mockImplementation(async () =>
      jsonResponse({ models: [{ id: 'echo', name: 'Echo (offline)', contextLimit: 8192 }] }),
    );
    const result = await callHandler(session, 'models.list', { providerId: 'provider-1' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/providers/provider-1/models');
    expect(result).toEqual({
      models: [{ id: 'echo', name: 'Echo (offline)', contextLimit: 8192 }],
    });
  });

  it('defaults to the active provider id when providerId is omitted', async () => {
    const { ctx, session } = makeContext({
      capabilities: ['models.list'],
      providerId: 'active-provider',
    });
    attachModels(ctx);
    fetchMock.mockImplementation(async () => jsonResponse({ models: [] }));
    await callHandler(session, 'models.list', {});
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/providers/active-provider/models');
  });

  it('rejects with NOT_FOUND when neither providerId nor an active provider exists', async () => {
    const { ctx, session } = makeContext({ capabilities: ['models.list'], providerId: null });
    attachModels(ctx);
    await expect(callHandler(session, 'models.list', {})).rejects.toMatchObject({
      code: kernel.KernelErrorCode.NOT_FOUND,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with NOT_FOUND when the server reports PROVIDER_NOT_FOUND', async () => {
    const { ctx, session } = makeContext({ capabilities: ['models.list'] });
    attachModels(ctx);
    fetchMock.mockImplementation(async () =>
      jsonResponse({ code: 'PROVIDER_NOT_FOUND', params: { providerId: 'ghost' } }, 404),
    );
    await expect(
      callHandler(session, 'models.list', { providerId: 'ghost' }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.NOT_FOUND });
  });

  it('rejects non-string providerId with VALIDATION_FAILED', async () => {
    const { ctx, session, capabilityChecks } = makeContext({ capabilities: ['models.list'] });
    attachModels(ctx);
    await expect(callHandler(session, 'models.list', { providerId: 42 })).rejects.toMatchObject({
      code: kernel.KernelErrorCode.VALIDATION_FAILED,
      details: { field: 'providerId' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(capabilityChecks).toHaveLength(0); // validation runs before the grant check
  });

  it('caps the model list at MODELS_MAX_LIST', async () => {
    const { ctx, session } = makeContext({ capabilities: ['models.list'] });
    attachModels(ctx);
    const models = Array.from({ length: 300 }, (_, index) => ({
      id: `m-${index}`,
      name: `M ${index}`,
    }));
    fetchMock.mockImplementation(async () => jsonResponse({ models }));
    const result = (await callHandler(session, 'models.list', {
      providerId: 'provider-1',
    })) as { models: unknown[] };
    expect(result.models).toHaveLength(256);
    expect(result.models[0]).toEqual({ id: 'm-0', name: 'M 0' });
    expect(result.models[255]).toEqual({ id: 'm-255', name: 'M 255' });
  });

  it('rejects a malformed response with PROTOCOL_INVALID', async () => {
    const { ctx, session } = makeContext({ capabilities: ['models.list'] });
    attachModels(ctx);
    fetchMock.mockImplementation(async () => jsonResponse({ items: [] }));
    await expect(
      callHandler(session, 'models.list', { providerId: 'provider-1' }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.PROTOCOL_INVALID });
  });
});
