/**
 * Rev4 kernel capabilities slice (web host side): listing and the consent
 * round-trip for runtime grant requests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import { attachCapabilities } from './capabilities.js';
import type { KernelHostContext } from './types.js';

const { KernelErrorCode } = kernel;

function fakeContext(grantedCapabilities: readonly unknown[] = []) {
  const handlers = new Map<string, (ctx: { params: unknown }) => unknown>();
  const session = {
    handle: vi.fn((method: string, handler: (ctx: { params: unknown }) => unknown) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
  };
  const consentCalls: Array<{ name: string; scope?: unknown }> = [];
  const runtime = {
    requestCapabilityConsent: vi.fn(
      (frame: unknown, request: { name: string; scope?: unknown }) => {
        consentCalls.push(request);
        return Promise.resolve({ name: request.name, revision: 2, grantedAt: 1 });
      },
    ),
  };
  const ctx = {
    pluginId: 'test.capabilities',
    frame: { plugin: { grantedCapabilities: [...grantedCapabilities] } },
    session,
    runtime,
    hasCapability: (name: string) =>
      grantedCapabilities.some((grant) => (grant as { name?: string }).name === name),
    currentChatId: () => null,
  } as unknown as KernelHostContext;
  return { ctx, handlers, session, runtime, consentCalls };
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

/** Wrap a possibly-synchronous handler invocation in a promise. */
function invokeAsync(
  handlers: Map<string, (ctx: { params: unknown }) => unknown>,
  method: string,
  params: unknown,
) {
  return Promise.resolve().then(() => invoke(handlers, method, params));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kernel capabilities', () => {
  it('registers list and request wire methods', () => {
    const fake = fakeContext();
    attachCapabilities(fake.ctx);
    expect([...fake.handlers.keys()].sort()).toEqual(['capabilities.list', 'capabilities.request']);
  });

  it('lists the live grant set capped to 64 entries', () => {
    const grants = Array.from({ length: 80 }, (_, index) => ({
      name: `cap.${index}`,
      revision: 1,
      grantedAt: 1,
    }));
    const fake = fakeContext(grants);
    attachCapabilities(fake.ctx);
    const result = invoke(fake.handlers, 'capabilities.list', {});
    expect(result).toEqual({ grants: grants.slice(0, 64) });
  });

  it('validates the request name before showing consent', async () => {
    const fake = fakeContext();
    attachCapabilities(fake.ctx);
    for (const params of [{}, { name: 42 }, { name: '' }, { name: 'x'.repeat(129) }]) {
      await expect(
        invokeAsync(fake.handlers, 'capabilities.request', params),
      ).rejects.toMatchObject({
        code: KernelErrorCode.VALIDATION_FAILED,
      });
    }
    expect(fake.runtime.requestCapabilityConsent).not.toHaveBeenCalled();
  });

  it('rejects non-plain scopes without asking the user', async () => {
    const fake = fakeContext();
    attachCapabilities(fake.ctx);
    await expect(
      invokeAsync(fake.handlers, 'capabilities.request', { name: 'network.domains', scope: 7 }),
    ).rejects.toMatchObject({ code: KernelErrorCode.VALIDATION_FAILED });
    expect(fake.runtime.requestCapabilityConsent).not.toHaveBeenCalled();
  });

  it('runs the consent round-trip and returns the persisted grant', async () => {
    const fake = fakeContext();
    attachCapabilities(fake.ctx);
    const result = await invokeAsync(fake.handlers, 'capabilities.request', {
      name: 'camera.request',
    });
    expect(fake.consentCalls).toEqual([{ name: 'camera.request' }]);
    expect(result).toEqual({ grant: { name: 'camera.request', revision: 2, grantedAt: 1 } });
  });

  it('passes the scope through to the runtime consent', async () => {
    const fake = fakeContext();
    attachCapabilities(fake.ctx);
    await invokeAsync(fake.handlers, 'capabilities.request', {
      name: 'network.domains',
      scope: { kind: 'origins', origins: ['https://api.example.com'] },
    });
    expect(fake.consentCalls).toEqual([
      { name: 'network.domains', scope: { kind: 'origins', origins: ['https://api.example.com'] } },
    ]);
  });
});
