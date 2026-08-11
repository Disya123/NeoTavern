/**
 * Main Host broker host tests (Stage D part 9c): the production policy
 * (part 9) wired into the broker core, bridged to the Runtime RPC frames
 * (part 9b). Pins: host-ward decisions round-trip as RPC_RESPONSE frames,
 * host-initiated revoke aborts in-flight and notifies the runtime, and
 * malformed frames degrade to VALIDATION_FAILED without poisoning other
 * calls.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DEFAULT_PROVIDER_TIMEOUTS, type ProviderRegistry } from '@neotavern/provider-sdk';
import type { AppDatabase } from '@neotavern/db';
import type {
  BrokerCallRequest,
  PluginRuntimeBridgeMessageBody,
  PluginRuntimeBrokerRevokeBody,
  PluginRuntimeRpcRequestBody,
  PluginRuntimeRpcResponseBody,
} from '@neotavern/contracts';
import { createTestApp } from './helpers.js';
import {
  attachVNextBrokerHost,
  createPluginRuntimeTransport,
  createVNextBrokerHost,
  type VNextBrokerHostService,
  type VNextBrokerTransport,
} from '../src/plugin/vnextBrokerHost.js';
import type { VNextBrokerHost } from '../src/plugin/vnextBroker.js';

const PLUGIN_ID = 'test.vnext-host';
const INSTALLATION_ID = 'install-00000001';
const WORKER = { workerId: 7, workerEpoch: 2 };

class MemoryTransport implements VNextBrokerTransport {
  readonly responses: PluginRuntimeRpcResponseBody[] = [];
  readonly revokes: PluginRuntimeBrokerRevokeBody[] = [];
  readonly hostBridgeMessages: PluginRuntimeBridgeMessageBody[] = [];
  sendRpcResponse(body: PluginRuntimeRpcResponseBody): void {
    this.responses.push(body);
  }
  sendBrokerRevoke(body: PluginRuntimeBrokerRevokeBody): void {
    this.revokes.push(body);
  }
  sendHostBridgeMessage(body: PluginRuntimeBridgeMessageBody): void {
    this.hostBridgeMessages.push(body);
  }
}

let database: AppDatabase;
let providers: ProviderRegistry;
let ctx: VNextBrokerHost;
let transport: MemoryTransport;
let host: VNextBrokerHostService;

function brokerCall(overrides: Partial<BrokerCallRequest> = {}): BrokerCallRequest {
  return {
    requestId: 'req-00000001',
    caller: { pluginId: PLUGIN_ID, installationId: INSTALLATION_ID, trustLevel: 'sandbox' },
    method: 'characters.list',
    args: {},
    capability: { name: 'characters.read', scope: {} },
    revision: 1,
    deadlineAt: Date.now() + 10_000,
    causalChain: [],
    ...overrides,
  };
}

function frame(body: BrokerCallRequest): PluginRuntimeRpcRequestBody {
  return { workerId: WORKER.workerId, workerEpoch: WORKER.workerEpoch, call: body };
}

function callWith(overrides: Partial<BrokerCallRequest>): PluginRuntimeRpcRequestBody {
  return frame(brokerCall(overrides));
}

async function waitForResponse(transport: MemoryTransport): Promise<PluginRuntimeRpcResponseBody> {
  for (let i = 0; i < 200; i += 1) {
    if (transport.responses.length > 0)
      return transport.responses[0] as PluginRuntimeRpcResponseBody;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no RPC_RESPONSE arrived');
}

beforeEach(async () => {
  const handle = await createTestApp();
  database = handle.database;
  providers = handle.providers;
  ctx = { database, providers, config: { providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS } };
  transport = new MemoryTransport();
  host = createVNextBrokerHost(ctx, transport);
  database.repos.plugins.install({
    id: PLUGIN_ID,
    name: PLUGIN_ID,
    version: '1.0.0',
    manifest: { id: PLUGIN_ID, name: PLUGIN_ID, version: '1.0.0', apiVersion: 3 },
    requestedPermissions: [],
  });
});

describe('host-ward decisions (RPC_REQUEST → RPC_RESPONSE)', () => {
  it('admits a granted call and returns the executed result', async () => {
    database.repos.capabilityGrants.grant({
      pluginId: PLUGIN_ID,
      name: 'characters.read',
      scope: {},
    });
    host.handleRpcRequest(callWith({}));
    const response = await waitForResponse(transport);
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-00000001');
    expect(response.workerId).toBe(WORKER.workerId);
    expect(response.workerEpoch).toBe(WORKER.workerEpoch);
    expect(response.result).toEqual({ items: [], nextCursor: null });
  });

  it('returns CAPABILITY_DENIED for an ungranted call', async () => {
    host.handleRpcRequest(callWith({}));
    const response = await waitForResponse(transport);
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'CAPABILITY_DENIED',
      retryable: false,
    });
  });

  it('enforces the §31 trust gate over the wire', async () => {
    database.repos.capabilityGrants.grant({
      pluginId: PLUGIN_ID,
      name: 'database.core.read',
      scope: {},
    });
    host.handleRpcRequest(
      callWith({
        method: 'database.core.query',
        args: { sql: 'SELECT 1', params: [] },
        capability: { name: 'database.core.read', scope: {} },
      }),
    );
    const response = await waitForResponse(transport);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('TRUST_REQUIRED');
  });

  it('echoes the worker identity on every response', async () => {
    host.handleRpcRequest(callWith({ requestId: 'req-00000002' }));
    const response = await waitForResponse(transport);
    expect(response.workerId).toBe(WORKER.workerId);
    expect(response.workerEpoch).toBe(WORKER.workerEpoch);
  });
});

function networkFrame(): PluginRuntimeRpcRequestBody {
  return callWith({
    method: 'network.http.fetch',
    args: { url: 'https://example.com' },
    capability: { name: 'network.http', scope: {} },
  });
}

function hangingHost(): {
  host: VNextBrokerHostService;
  markStarted: () => void;
  startedPromise: Promise<void>;
} {
  let markStarted: () => void = () => undefined;
  const startedPromise = new Promise<void>((resolveStart) => {
    markStarted = resolveStart;
  });
  // `network.http.fetch` is a signal-aware backend: the executor hands the
  // call's AbortSignal to fetchImpl, so a revoke rejects the in-flight
  // decision exactly like a real slow network request would.
  const hanging = createVNextBrokerHost(ctx, transport, {
    dnsLookupImpl: async () => ['93.184.216.34'],
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        markStarted();
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  });
  return { host: hanging, markStarted, startedPromise };
}

describe('revoke (host-driven)', () => {
  it('aborts the host-side in-flight call and notifies the runtime', async () => {
    const { host: hanging, startedPromise } = hangingHost();
    database.repos.capabilityGrants.grant({ pluginId: PLUGIN_ID, name: 'network.http', scope: {} });
    hanging.handleRpcRequest(networkFrame());
    await startedPromise;
    expect(hanging.pendingCount()).toBe(1);
    expect(hanging.revoke(PLUGIN_ID, 'network.http', 'user said no')).toBe(1);
    expect(transport.revokes).toEqual([
      { pluginId: PLUGIN_ID, name: 'network.http', reason: 'user said no' },
    ]);
    const response = await waitForResponse(transport);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('CAPABILITY_REVOKED');
    expect(hanging.pendingCount()).toBe(0);
    expect(hanging.isRevoked(PLUGIN_ID, 'network.http')).toBe(true);
  });

  it('revokes a whole plugin when name is omitted', () => {
    expect(host.revoke(PLUGIN_ID, undefined, 'disable')).toBe(0);
    expect(transport.revokes).toEqual([
      { pluginId: PLUGIN_ID, name: undefined, reason: 'disable' },
    ]);
    expect(host.isRevoked(PLUGIN_ID, 'characters.read')).toBe(true);
  });
});

describe('live delivery (§18, Stage F)', () => {
  function subscribeCall(args: Record<string, unknown>): PluginRuntimeRpcRequestBody {
    return frame(
      brokerCall({
        method: 'events.subscribe',
        args,
        capability: { name: 'events', scope: {} },
        revision: undefined,
      }),
    );
  }

  it('pushes emitted events to the subscribing worker via HOST_BRIDGE_MESSAGE', async () => {
    host.handleRpcRequest(subscribeCall({ name: 'live.tick' }));
    const response = await waitForResponse(transport);
    expect(response.ok).toBe(true);
    const subscriptionId = (response.result as { subscriptionId: string }).subscriptionId;
    expect(subscriptionId).toMatch(/^sub-/);

    host.emitEvent('live.tick', { n: 1 });
    expect(transport.hostBridgeMessages).toEqual([
      {
        workerId: WORKER.workerId,
        workerEpoch: WORKER.workerEpoch,
        message: {
          kind: 'event-push',
          subscriptionId,
          envelope: expect.objectContaining({ seq: 1, payload: { n: 1 } }),
        },
      },
    ]);
  });

  it('only pushes events matching the subscribed name', async () => {
    host.handleRpcRequest(subscribeCall({ name: 'live.tick' }));
    await waitForResponse(transport);
    host.emitEvent('other.tick', 1);
    expect(transport.hostBridgeMessages).toEqual([]);
    // The ring still recorded it (the event core is global).
    host.emitEvent('live.tick', 2);
    expect(transport.hostBridgeMessages).toHaveLength(1);
  });

  it('stops routing after unsubscribe and after worker termination', async () => {
    host.handleRpcRequest(subscribeCall({ name: 'live.tick' }));
    const response = await waitForResponse(transport);
    const subscriptionId = (response.result as { subscriptionId: string }).subscriptionId;

    // unsubscribe removes the routing entry.
    transport.responses.length = 0;
    host.handleRpcRequest(
      frame(
        brokerCall({
          method: 'events.unsubscribe',
          args: { subscriptionId },
          capability: { name: 'events', scope: {} },
          revision: undefined,
        }),
      ),
    );
    const unsubResponse = await waitForResponse(transport);
    expect(unsubResponse.ok).toBe(true);
    host.emitEvent('live.tick', 1);
    expect(transport.hostBridgeMessages).toEqual([]);

    // Re-subscribe, then terminate the worker: routing is pruned.
    transport.responses.length = 0;
    host.handleRpcRequest(subscribeCall({ name: 'live.tick' }));
    const response2 = await waitForResponse(transport);
    const id2 = (response2.result as { subscriptionId: string }).subscriptionId;
    expect(id2).not.toBe(subscriptionId);
    host.workerTerminated(WORKER.workerId);
    host.emitEvent('live.tick', 2);
    expect(transport.hostBridgeMessages).toEqual([]);
  });

  it('emitEvent returns the buffered envelope and never throws on transport failure', () => {
    const envelope = host.emitEvent('live.tick', 1);
    expect(envelope).toMatchObject({ seq: 1, name: 'live.tick', payload: 1 });
    // No subscription: no pushes, no transport access.
    expect(transport.hostBridgeMessages).toEqual([]);
  });
});

describe('frame hardening', () => {
  it('degrades a malformed frame body to VALIDATION_FAILED', async () => {
    host.handleRpcRequest({ workerId: 'not-a-number' });
    const response = await waitForResponse(transport);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('VALIDATION_FAILED');
    // Unmatchable requestId: the runtime drops responses for unknown ids, so
    // this must never collide with a real call.
    expect(response.requestId).toBe('malformed-frame');
  });

  it('degrades a malformed call envelope to VALIDATION_FAILED', async () => {
    host.handleRpcRequest({
      workerId: WORKER.workerId,
      workerEpoch: WORKER.workerEpoch,
      call: { requestId: 'short' },
    });
    const response = await waitForResponse(transport);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('VALIDATION_FAILED');
  });

  it('caps concurrent host-side decisions with SERVICE_UNAVAILABLE', async () => {
    const small = createVNextBrokerHost(ctx, transport, {
      maxInflight: 1,
      charactersList: () => new Promise(() => undefined),
    });
    // The first call must be admitted and stay in flight (granted), so the
    // second one hits the host-side capacity gate.
    database.repos.capabilityGrants.grant({
      pluginId: PLUGIN_ID,
      name: 'characters.read',
      scope: {},
    });
    small.handleRpcRequest(callWith({}));
    small.handleRpcRequest(callWith({ requestId: 'req-00000002' }));
    for (let i = 0; i < 200 && transport.responses.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(transport.responses[0]).toMatchObject({
      requestId: 'req-00000002',
      ok: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
    small.shutdown();
  });

  it('aborts every in-flight decision on shutdown', async () => {
    const { host: hanging, startedPromise } = hangingHost();
    database.repos.capabilityGrants.grant({ pluginId: PLUGIN_ID, name: 'network.http', scope: {} });
    hanging.handleRpcRequest(networkFrame());
    await startedPromise;
    hanging.shutdown();
    expect(hanging.pendingCount()).toBe(0);
    const response = await waitForResponse(transport);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('CAPABILITY_REVOKED');
  });
});

describe('transport wiring', () => {
  it('adapts a PluginRuntimeClient-shaped transport', () => {
    const client = {
      sendRpcResponse: vi.fn(),
      sendBrokerRevoke: vi.fn(),
    };
    const adapter = createPluginRuntimeTransport(client);
    adapter.sendRpcResponse({
      workerId: 1,
      workerEpoch: 1,
      requestId: 'req-00000001',
      ok: true,
      result: 1,
    });
    adapter.sendBrokerRevoke({ pluginId: 'p', name: 'n' });
    expect(client.sendRpcResponse).toHaveBeenCalledTimes(1);
    expect(client.sendBrokerRevoke).toHaveBeenCalledTimes(1);
  });

  it('attaches and detaches client rpcRequest events', async () => {
    const listeners = new Map<string, Array<(body: unknown) => void>>();
    const client = {
      on: vi.fn((event: string, listener: (body: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      }),
      off: vi.fn((event: string, listener: (body: unknown) => void) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((entry) => entry !== listener),
        );
      }),
      sendRpcResponse: vi.fn(),
      sendBrokerRevoke: vi.fn(),
    };
    const transportStub = { sendRpcResponse: vi.fn(), sendBrokerRevoke: vi.fn() };
    const attached = createVNextBrokerHost(ctx, transportStub);
    const detach = attachVNextBrokerHost(client, attached);
    const emit = (body: unknown): void => {
      for (const listener of listeners.get('rpcRequest') ?? []) listener(body);
    };
    emit(callWith({}));
    for (let i = 0; i < 200 && transportStub.sendRpcResponse.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(transportStub.sendRpcResponse).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledWith('rpcRequest', expect.any(Function));
    detach();
    emit(callWith({ requestId: 'req-00000002' }));
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(transportStub.sendRpcResponse).toHaveBeenCalledTimes(1);
  });
});
