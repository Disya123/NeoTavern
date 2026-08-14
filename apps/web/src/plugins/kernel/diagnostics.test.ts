/**
 * Rev4 kernel diagnostics (web host side): the wire method and the read-only
 * self-diagnostics snapshot built from public registry fields only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import type { InstalledPlugin } from '@neotavern/contracts';
import { FrontendPluginRuntime } from '../runtime.js';
import { attachDiagnostics } from './diagnostics.js';
import type { KernelHostContext } from './types.js';

const { KernelErrorCode } = kernel;

function fakeContext(snapshot: kernel.DiagnosticsSnapshot = emptySnapshot()) {
  const handlers = new Map<string, (ctx: { params: unknown }) => unknown>();
  const session = {
    handle: vi.fn((method: string, handler: (ctx: { params: unknown }) => unknown) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
  };
  const runtime = {
    kernelDiagnosticsSnapshot: vi.fn(() => snapshot),
  };
  const ctx = {
    pluginId: 'test.diagnostics',
    frame: {},
    session,
    runtime,
    hasCapability: () => true,
    currentChatId: () => null,
  } as unknown as KernelHostContext;
  return { ctx, handlers, session, runtime };
}

function emptySnapshot(): kernel.DiagnosticsSnapshot {
  return {
    protocolVersion: '2.0',
    sdkVersion: '1.0.0',
    instanceId: 'rev4:test',
    plugin: {
      id: 'test.diagnostics',
      name: 'Test Diagnostics',
      version: '1.0.0',
      apiVersion: 2,
      status: 'active',
      lastErrorCode: null,
      compatibilityLevel: 'native-v2',
    },
    limits: kernel.DEFAULT_PLUGIN_LIMITS,
    features: {},
    grants: [],
  };
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

type WireGrant = { name: string; revision: number; grantedAt: number; scope?: unknown };

function installedPlugin(
  grantedCapabilities: readonly WireGrant[] = [],
  overrides: Partial<InstalledPlugin> = {},
): InstalledPlugin {
  return {
    id: 'test.diagnostics',
    name: 'Test Diagnostics',
    version: '2.3.4',
    apiVersion: 2,
    enabled: true,
    status: 'active',
    manifest: {},
    requestedPermissions: [],
    grantedPermissions: [],
    grantedCapabilities: [...grantedCapabilities],
    addedPermissions: [],
    installedAt: 1,
    updatedAt: 1,
    hasFrontend: true,
    hasBackend: false,
    hasStyles: false,
    hasLegacyFrontend: false,
    hasLegacyBackend: false,
    compatibilityLevel: 'native-v2',
    trust: 'unsigned-untrusted',
    lastErrorCode: 'ACTIVATION_FAILED',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('kernel diagnostics slice', () => {
  it('registers the diagnostics.get wire method', () => {
    const fake = fakeContext();
    attachDiagnostics(fake.ctx);
    expect([...fake.handlers.keys()]).toEqual(['diagnostics.get']);
  });

  it('returns the host-built snapshot unchanged', () => {
    const snapshot = emptySnapshot();
    const fake = fakeContext(snapshot);
    attachDiagnostics(fake.ctx);
    const result = invoke(fake.handlers, 'diagnostics.get', {});
    expect(result).toEqual({ snapshot });
    expect(fake.runtime.kernelDiagnosticsSnapshot).toHaveBeenCalledOnce();
  });

  it('propagates runtime snapshot failures as kernel errors', () => {
    const fake = fakeContext();
    fake.runtime.kernelDiagnosticsSnapshot.mockImplementation(() => {
      throw new kernel.KernelError(KernelErrorCode.INTERNAL, {});
    });
    attachDiagnostics(fake.ctx);
    expect(() => invoke(fake.handlers, 'diagnostics.get', {})).toThrowError(
      expect.objectContaining({ code: KernelErrorCode.INTERNAL }),
    );
  });
});

describe('kernel diagnostics snapshot (host build)', () => {
  it('exposes protocol/sdk versions, instance id, limits and feature registry', () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.diagnostics');
    expect(frame).not.toBeUndefined();
    const snapshot = runtime.kernelDiagnosticsSnapshot(frame!);
    expect(snapshot.protocolVersion).toBe(kernel.PROTOCOL_VERSION);
    expect(snapshot.sdkVersion).toBe(kernel.KERNEL_SDK_VERSION);
    expect(snapshot.limits).toEqual(kernel.DEFAULT_PLUGIN_LIMITS);
    expect(Object.keys(snapshot.features).length).toBeGreaterThan(0);
    runtime.clear();
  });

  it('copies registry identity fields without leaking secrets', () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.diagnostics');
    const snapshot = runtime.kernelDiagnosticsSnapshot(frame!);
    expect(snapshot.plugin).toEqual({
      id: 'test.diagnostics',
      name: 'Test Diagnostics',
      version: '2.3.4',
      apiVersion: 2,
      status: 'active',
      lastErrorCode: 'ACTIVATION_FAILED',
      compatibilityLevel: 'native-v2',
    });
    expect(JSON.stringify(snapshot)).not.toContain('manifest');
    runtime.clear();
  });

  it('lists grants capped to 64 entries', () => {
    const grants = Array.from({ length: 80 }, (_, index) => ({
      name: `cap.${index}`,
      revision: 1,
      grantedAt: 1,
    }));
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin(grants)]);
    const frame = runtime.kernelGetFrame('test.diagnostics');
    const snapshot = runtime.kernelDiagnosticsSnapshot(frame!);
    expect(snapshot.grants).toHaveLength(64);
    expect(snapshot.grants[0]).toMatchObject({ name: 'cap.0' });
    expect(snapshot.grants[63]).toMatchObject({ name: 'cap.63' });
    runtime.clear();
  });

  it('returns an empty grant list when none are granted', () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.diagnostics');
    expect(runtime.kernelDiagnosticsSnapshot(frame!).grants).toEqual([]);
    runtime.clear();
  });

  it('drops revoked grants on the next snapshot', () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([
      installedPlugin([
        { name: 'camera.request', revision: 1, grantedAt: 1 },
        { name: 'network.domains', revision: 1, grantedAt: 1 },
      ]),
    ]);
    const frame = runtime.kernelGetFrame('test.diagnostics');
    expect(runtime.kernelDiagnosticsSnapshot(frame!).grants.map((grant) => grant.name)).toEqual([
      'camera.request',
      'network.domains',
    ]);
    frame!.plugin.grantedCapabilities = frame!.plugin.grantedCapabilities.filter(
      (grant) => grant.name !== 'camera.request',
    );
    expect(runtime.kernelDiagnosticsSnapshot(frame!).grants.map((grant) => grant.name)).toEqual([
      'network.domains',
    ]);
    runtime.clear();
  });

  it('does not mutate the shared limits object across calls', () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.diagnostics');
    const first = runtime.kernelDiagnosticsSnapshot(frame!);
    const second = runtime.kernelDiagnosticsSnapshot(frame!);
    expect(first.limits).not.toBe(kernel.DEFAULT_PLUGIN_LIMITS);
    expect(second.limits).toEqual(kernel.DEFAULT_PLUGIN_LIMITS);
    runtime.clear();
  });
});
