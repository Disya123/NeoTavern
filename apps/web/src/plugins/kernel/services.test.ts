/**
 * Rev4 kernel services slice (web host side): cross-plugin RPC mediation
 * (rev4 §D). Covers capability gates, the registry round-trip between two
 * plugin sessions and the failure mapping (SERVICE_* codes). The fake runtime
 * mirrors FrontendPluginRuntime's registry; the provider frame's session
 * simulates the sandbox-side `services.invoke` handler.
 */
import { describe, expect, it, vi } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import { attachServices } from './services.js';
import type { KernelHostContext } from './types.js';
import type { RuntimeServiceEntry } from '../runtime.js';

const { KernelErrorCode } = kernel;

type WireContext = { params: unknown; signal?: AbortSignal };

interface FakeSession {
  handle: ReturnType<typeof vi.fn>;
  handlers: Map<string, (ctx: WireContext) => unknown>;
}

interface FakeProviderFrame {
  session: {
    call: ReturnType<typeof vi.fn>;
    isDisposed: boolean;
  };
}

function makeFakeRuntime() {
  const services = new Map<string, RuntimeServiceEntry>();
  const connections = new Map<
    string,
    { connectionId: string; consumerPluginId: string; serviceId: string }
  >();
  const frames = new Map<string, FakeProviderFrame>();
  let seq = 0;
  return {
    frames,
    kernelServiceRegister(entry: RuntimeServiceEntry): boolean {
      if (services.has(entry.serviceId)) return false;
      services.set(entry.serviceId, entry);
      return true;
    },
    kernelServiceRemoveByPlugin(pluginId: string): void {
      for (const [serviceId, entry] of services) {
        if (entry.providerPluginId === pluginId) services.delete(serviceId);
      }
      for (const [connectionId, connection] of connections) {
        const entry = services.get(connection.serviceId);
        if (entry?.providerPluginId === pluginId) connections.delete(connectionId);
      }
    },
    kernelServiceRemoveByConsumer(pluginId: string): void {
      for (const [connectionId, connection] of connections) {
        if (connection.consumerPluginId === pluginId) connections.delete(connectionId);
      }
    },
    kernelServiceRemoveService(serviceId: string, providerPluginId: string): boolean {
      const entry = services.get(serviceId);
      if (!entry || entry.providerPluginId !== providerPluginId) return false;
      services.delete(serviceId);
      for (const [connectionId, connection] of connections) {
        if (connection.serviceId === serviceId) connections.delete(connectionId);
      }
      return true;
    },
    kernelServiceConnectionCount(consumerPluginId: string): number {
      let count = 0;
      for (const connection of connections.values()) {
        if (connection.consumerPluginId === consumerPluginId) count += 1;
      }
      return count;
    },
    kernelServiceList(): RuntimeServiceEntry[] {
      return [...services.values()].map((entry) => ({ ...entry }));
    },
    kernelServiceGet(serviceId: string): RuntimeServiceEntry | undefined {
      return services.get(serviceId);
    },
    kernelServiceCreateConnection(consumerPluginId: string, serviceId: string): string | null {
      seq += 1;
      const connectionId = `conn-${seq}`;
      connections.set(connectionId, { connectionId, consumerPluginId, serviceId });
      return connectionId;
    },
    kernelServiceGetConnection(
      consumerPluginId: string,
      connectionId: string,
    ): { connectionId: string; consumerPluginId: string; serviceId: string } | undefined {
      const connection = connections.get(connectionId);
      return connection && connection.consumerPluginId === consumerPluginId
        ? connection
        : undefined;
    },
    kernelServiceRemoveConnection(consumerPluginId: string, connectionId: string): void {
      const connection = connections.get(connectionId);
      if (connection?.consumerPluginId === consumerPluginId) connections.delete(connectionId);
    },
    kernelGetFrame(pluginId: string): FakeProviderFrame | undefined {
      return frames.get(pluginId);
    },
  };
}

function fakeContext(
  runtime: ReturnType<typeof makeFakeRuntime>,
  pluginId: string,
  capabilities: ReadonlySet<string>,
) {
  const handlers = new Map<string, (ctx: WireContext) => unknown>();
  const session: FakeSession = {
    handle: vi.fn((method: string, handler: (ctx: WireContext) => unknown) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    handlers,
  };
  const ctx = {
    pluginId,
    frame: {},
    session,
    runtime,
    hasCapability: (name: string) => capabilities.has(name),
    currentChatId: () => null,
  } as unknown as KernelHostContext;
  return { ctx, handlers };
}

function invoke(
  handlers: Map<string, (ctx: WireContext) => unknown>,
  method: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`no handler for ${method}`);
  // Route sync throws into rejected promises so `.rejects` sees them.
  return Promise.resolve().then(() =>
    handler({ params, signal: signal ?? new AbortController().signal }),
  );
}

function registeredMethodNames(runtime: ReturnType<typeof makeFakeRuntime>): string[] {
  return runtime
    .kernelServiceList()
    .map((entry) => entry.serviceId)
    .sort();
}

const PROVIDER = 'test.provider';
const CONSUMER = 'test.consumer';

/** Provider registers a service; returns the full serviceId. */
async function provideService(
  runtime: ReturnType<typeof makeFakeRuntime>,
  handlers: Map<string, (ctx: WireContext) => unknown>,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const result = (await invoke(handlers, 'services.provide', {
    name: 'greeter',
    methods: ['greet', 'echo'],
    ...overrides,
  })) as { serviceId: string };
  return result.serviceId;
}

describe('kernel services', () => {
  it('registers the six wire methods', () => {
    const runtime = makeFakeRuntime();
    const fake = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(fake.ctx);
    expect([...fake.handlers.keys()].sort()).toEqual([
      'services.connect',
      'services.disconnect',
      'services.invoke',
      'services.list',
      'services.provide',
      'services.unprovide',
    ]);
  });

  it('gates provide/unprovide on services.provide', async () => {
    const runtime = makeFakeRuntime();
    const fake = fakeContext(runtime, PROVIDER, new Set());
    attachServices(fake.ctx);
    await expect(
      invoke(fake.handlers, 'services.provide', { name: 'x', methods: ['m'] }),
    ).rejects.toMatchObject({ code: KernelErrorCode.CAPABILITY_DENIED });
    await expect(
      invoke(fake.handlers, 'services.unprovide', { serviceId: 'a.b' }),
    ).rejects.toMatchObject({ code: KernelErrorCode.CAPABILITY_DENIED });
  });

  it('gates list/connect/invoke/disconnect on services.connect', async () => {
    const runtime = makeFakeRuntime();
    const fake = fakeContext(runtime, CONSUMER, new Set());
    attachServices(fake.ctx);
    await expect(invoke(fake.handlers, 'services.list', {})).rejects.toMatchObject({
      code: KernelErrorCode.CAPABILITY_DENIED,
    });
    await expect(
      invoke(fake.handlers, 'services.connect', { serviceId: 'a.b' }),
    ).rejects.toMatchObject({ code: KernelErrorCode.CAPABILITY_DENIED });
    await expect(
      invoke(fake.handlers, 'services.invoke', { connectionId: 'c', method: 'm' }),
    ).rejects.toMatchObject({ code: KernelErrorCode.CAPABILITY_DENIED });
    await expect(
      invoke(fake.handlers, 'services.disconnect', { connectionId: 'c' }),
    ).rejects.toMatchObject({ code: KernelErrorCode.CAPABILITY_DENIED });
  });

  it('publishes a host-prefixed serviceId and validates inputs', async () => {
    const runtime = makeFakeRuntime();
    const fake = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(fake.ctx);
    expect(await provideService(runtime, fake.handlers)).toBe(`${PROVIDER}.greeter`);
    expect(registeredMethodNames(runtime)).toEqual([`${PROVIDER}.greeter`]);

    await expect(
      invoke(fake.handlers, 'services.provide', { name: '1bad', methods: ['m'] }),
    ).rejects.toMatchObject({ code: KernelErrorCode.VALIDATION_FAILED });
    await expect(
      invoke(fake.handlers, 'services.provide', { name: 'ok', methods: [] }),
    ).rejects.toMatchObject({ code: KernelErrorCode.VALIDATION_FAILED });
    await expect(
      invoke(fake.handlers, 'services.provide', { name: 'ok', methods: ['m', 'm'] }),
    ).rejects.toMatchObject({ code: KernelErrorCode.VALIDATION_FAILED });
  });

  it('rejects a duplicate service from the same provider', async () => {
    const runtime = makeFakeRuntime();
    const fake = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(fake.ctx);
    await provideService(runtime, fake.handlers);
    await expect(
      invoke(fake.handlers, 'services.provide', { name: 'greeter', methods: ['x'] }),
    ).rejects.toMatchObject({
      code: KernelErrorCode.VALIDATION_FAILED,
      details: { reason: 'service-already-provided' },
    });
  });

  it('enforces the per-plugin service quota', async () => {
    const runtime = makeFakeRuntime();
    const fake = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(fake.ctx);
    for (let index = 0; index < 16; index += 1) {
      await invoke(fake.handlers, 'services.provide', {
        name: `svc${index}`,
        methods: ['m'],
      });
    }
    await expect(
      invoke(fake.handlers, 'services.provide', { name: 'overflow', methods: ['m'] }),
    ).rejects.toMatchObject({ code: KernelErrorCode.PLUGIN_QUOTA_EXCEEDED });
  });

  it('round-trips a cross-plugin call: list, connect, invoke', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers, { version: '1.0' });
    runtime.frames.set(PROVIDER, {
      session: {
        isDisposed: false,
        call: vi.fn(async (_method: string, params: Record<string, unknown>) => {
          const inner = params['params'] as Record<string, unknown> | undefined;
          return { greeting: `hi ${inner?.['name']}`, from: params['callerPluginId'] };
        }),
      },
    });

    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);

    const list = (await invoke(consumer.handlers, 'services.list', {})) as {
      items: Array<{
        serviceId: string;
        providerPluginId: string;
        methods: string[];
        version?: string;
      }>;
    };
    expect(list.items).toEqual([
      expect.objectContaining({
        serviceId,
        providerPluginId: PROVIDER,
        methods: ['greet', 'echo'],
        version: '1.0',
      }),
    ]);

    const connection = (await invoke(consumer.handlers, 'services.connect', {
      serviceId,
    })) as { connectionId: string; methods: string[] };
    expect(connection.methods).toEqual(['greet', 'echo']);

    const result = await invoke(consumer.handlers, 'services.invoke', {
      connectionId: connection.connectionId,
      method: 'greet',
      params: { name: 'Ada' },
    });
    expect(result).toEqual({ greeting: 'hi Ada', from: CONSUMER });

    const providerFrame = runtime.frames.get(PROVIDER)!;
    expect(providerFrame.session.call).toHaveBeenCalledWith(
      'services.invoke',
      {
        serviceId,
        method: 'greet',
        params: { name: 'Ada' },
        callerPluginId: CONSUMER,
      },
      expect.objectContaining({ deadlineMs: 10_000 }),
    );
  });

  it('connect to an unknown service fails with SERVICE_NOT_FOUND', async () => {
    const runtime = makeFakeRuntime();
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    await expect(
      invoke(consumer.handlers, 'services.connect', { serviceId: 'ghost.svc' }),
    ).rejects.toMatchObject({ code: KernelErrorCode.SERVICE_NOT_FOUND });
  });

  it('connect fails with SERVICE_UNAVAILABLE when the provider frame is gone', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers);
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    await expect(
      invoke(consumer.handlers, 'services.connect', { serviceId }),
    ).rejects.toMatchObject({ code: KernelErrorCode.SERVICE_UNAVAILABLE });
  });

  it('rejects a call on a connection owned by another consumer', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers);
    runtime.frames.set(PROVIDER, {
      session: { isDisposed: false, call: vi.fn(async () => 'ok') },
    });

    const owner = fakeContext(runtime, 'test.owner', new Set(['services.connect']));
    attachServices(owner.ctx);
    const connection = (await invoke(owner.handlers, 'services.connect', { serviceId })) as {
      connectionId: string;
    };

    const other = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(other.ctx);
    await expect(
      invoke(other.handlers, 'services.invoke', {
        connectionId: connection.connectionId,
        method: 'greet',
      }),
    ).rejects.toMatchObject({ code: KernelErrorCode.SERVICE_NOT_FOUND });
  });

  it('rejects undeclared methods with SERVICE_METHOD_NOT_FOUND', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers);
    runtime.frames.set(PROVIDER, {
      session: { isDisposed: false, call: vi.fn(async () => 'ok') },
    });
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    const connection = (await invoke(consumer.handlers, 'services.connect', { serviceId })) as {
      connectionId: string;
    };
    await expect(
      invoke(consumer.handlers, 'services.invoke', {
        connectionId: connection.connectionId,
        method: 'undeclared',
      }),
    ).rejects.toMatchObject({ code: KernelErrorCode.SERVICE_METHOD_NOT_FOUND });
    expect(runtime.frames.get(PROVIDER)!.session.call).not.toHaveBeenCalled();
  });

  it('wraps a provider handler error as SERVICE_ERROR with providerCode', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers);
    runtime.frames.set(PROVIDER, {
      session: {
        isDisposed: false,
        call: vi.fn(async () => {
          throw new kernel.KernelError('PLUGIN_QUOTA_EXCEEDED', { details: { reason: 'x' } });
        }),
      },
    });
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    const connection = (await invoke(consumer.handlers, 'services.connect', { serviceId })) as {
      connectionId: string;
    };
    await expect(
      invoke(consumer.handlers, 'services.invoke', {
        connectionId: connection.connectionId,
        method: 'greet',
      }),
    ).rejects.toMatchObject({
      code: KernelErrorCode.SERVICE_ERROR,
      details: { providerCode: 'PLUGIN_QUOTA_EXCEEDED', serviceId, method: 'greet' },
    });
  });

  it('maps a provider deadline to SERVICE_TIMEOUT', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers, { timeoutMs: 2000 });
    runtime.frames.set(PROVIDER, {
      session: {
        isDisposed: false,
        call: vi.fn(async () => {
          throw new kernel.KernelError(KernelErrorCode.OPERATION_DEADLINE);
        }),
      },
    });
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    const connection = (await invoke(consumer.handlers, 'services.connect', { serviceId })) as {
      connectionId: string;
    };
    await expect(
      invoke(consumer.handlers, 'services.invoke', {
        connectionId: connection.connectionId,
        method: 'greet',
      }),
    ).rejects.toMatchObject({ code: KernelErrorCode.SERVICE_TIMEOUT });
    expect(runtime.frames.get(PROVIDER)!.session.call).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ deadlineMs: 2000 }),
    );
  });

  it('maps a mid-call provider abort to SERVICE_UNAVAILABLE', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers);
    runtime.frames.set(PROVIDER, {
      session: {
        isDisposed: false,
        call: vi.fn(async () => {
          throw new kernel.KernelError(KernelErrorCode.OPERATION_ABORTED);
        }),
      },
    });
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    const connection = (await invoke(consumer.handlers, 'services.connect', { serviceId })) as {
      connectionId: string;
    };
    await expect(
      invoke(consumer.handlers, 'services.invoke', {
        connectionId: connection.connectionId,
        method: 'greet',
      }),
    ).rejects.toMatchObject({ code: KernelErrorCode.SERVICE_UNAVAILABLE });
  });

  it('passes through a consumer abort as OPERATION_ABORTED', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers);
    const abortController = new AbortController();
    abortController.abort();
    runtime.frames.set(PROVIDER, {
      session: {
        isDisposed: false,
        call: vi.fn(async (_method: string, _params: unknown, opts: { signal?: AbortSignal }) => {
          if (opts?.signal?.aborted) {
            throw new kernel.KernelError(KernelErrorCode.OPERATION_ABORTED);
          }
          return 'late';
        }),
      },
    });
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    const connection = (await invoke(consumer.handlers, 'services.connect', { serviceId })) as {
      connectionId: string;
    };
    await expect(
      invoke(
        consumer.handlers,
        'services.invoke',
        { connectionId: connection.connectionId, method: 'greet' },
        abortController.signal,
      ),
    ).rejects.toMatchObject({ code: KernelErrorCode.OPERATION_ABORTED });
  });

  it('caps oversize and non-JSON-safe payloads', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers);
    runtime.frames.set(PROVIDER, {
      session: { isDisposed: false, call: vi.fn(async () => 'ok') },
    });
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    const connection = (await invoke(consumer.handlers, 'services.connect', { serviceId })) as {
      connectionId: string;
    };
    await expect(
      invoke(consumer.handlers, 'services.invoke', {
        connectionId: connection.connectionId,
        method: 'greet',
        params: 'x'.repeat(300 * 1024),
      }),
    ).rejects.toMatchObject({ code: KernelErrorCode.PLUGIN_QUOTA_EXCEEDED });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(
      invoke(consumer.handlers, 'services.invoke', {
        connectionId: connection.connectionId,
        method: 'greet',
        params: circular,
      }),
    ).rejects.toMatchObject({ code: KernelErrorCode.VALIDATION_FAILED });
  });

  it('unprovide removes the service and its connections', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers);
    runtime.frames.set(PROVIDER, {
      session: { isDisposed: false, call: vi.fn(async () => 'ok') },
    });
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    const connection = (await invoke(consumer.handlers, 'services.connect', { serviceId })) as {
      connectionId: string;
    };
    await invoke(provider.handlers, 'services.unprovide', { serviceId });
    expect(registeredMethodNames(runtime)).toEqual([]);
    // The service entry and its consumer connections are dropped together.
    await expect(
      invoke(consumer.handlers, 'services.invoke', {
        connectionId: connection.connectionId,
        method: 'greet',
      }),
    ).rejects.toMatchObject({ code: KernelErrorCode.SERVICE_NOT_FOUND });
  });

  it('disconnect releases the consumer binding', async () => {
    const runtime = makeFakeRuntime();
    const provider = fakeContext(runtime, PROVIDER, new Set(['services.provide']));
    attachServices(provider.ctx);
    const serviceId = await provideService(runtime, provider.handlers);
    runtime.frames.set(PROVIDER, {
      session: { isDisposed: false, call: vi.fn(async () => 'ok') },
    });
    const consumer = fakeContext(runtime, CONSUMER, new Set(['services.connect']));
    attachServices(consumer.ctx);
    const connection = (await invoke(consumer.handlers, 'services.connect', { serviceId })) as {
      connectionId: string;
    };
    await invoke(consumer.handlers, 'services.disconnect', {
      connectionId: connection.connectionId,
    });
    await expect(
      invoke(consumer.handlers, 'services.invoke', {
        connectionId: connection.connectionId,
        method: 'greet',
      }),
    ).rejects.toMatchObject({ code: KernelErrorCode.SERVICE_NOT_FOUND });
  });
});
