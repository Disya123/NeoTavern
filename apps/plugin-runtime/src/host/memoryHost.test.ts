/**
 * Memory host executor unit tests (Stage D, ТЗ §12 Application/Storage).
 *
 * Drives the executor through the real broker core (submit → policy →
 * execute), so the tests pin the full admission → grant → dispatch path.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokerCallRequest, SdkServiceCallEnvelope } from '@neotavern/contracts';
import type { SecretsProvider } from './memoryHost.js';
import { NETWORK_MAX_BODY_BYTES } from '@neotavern/contracts';
import { BrokerErrorCode, createCapabilityBrokerCore } from '../broker/capabilityBroker.js';
import { createMemoryHostExecutor, type MemoryHostExecutor } from './memoryHost.js';

const METHOD_CAPABILITY: Record<string, string> = {
  'storage.kv.get': 'storage.kv',
  'storage.kv.set': 'storage.kv',
  'storage.kv.delete': 'storage.kv',
  'storage.kv.list': 'storage.kv',
  'settings.get': 'settings.read',
  'services.provide': 'services.provide',
  'services.connect': 'services.connect',
  'services.respond': 'services.provide',
  'secrets.use': 'secrets.use',
  'secrets.manageOwn': 'secrets.manageOwn',
  'secrets.reveal': 'secrets.reveal',
  'settings.set': 'settings.write',
  'events.replay': 'events',
  'events.subscribe': 'events',
  'events.unsubscribe': 'events',
};

function makeCall(overrides: Partial<BrokerCallRequest> = {}): BrokerCallRequest {
  const method = overrides.method ?? 'storage.kv.get';
  return {
    requestId: 'req-sdk-aaaaaaaa',
    caller: { pluginId: 'plugin-a', installationId: 'inst-a', trustLevel: 'sandbox' },
    method,
    args: { key: 'greeting' },
    capability: { name: METHOD_CAPABILITY[method] ?? 'storage.kv' },
    deadlineAt: Date.now() + 10_000,
    causalChain: [],
    ...overrides,
  };
}

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

function wired(host: MemoryHostExecutor) {
  return createCapabilityBrokerCore(host.policy);
}

const ALL_GRANTS = ['storage.kv', 'settings.read', 'settings.write'];

describe('memory host executor', () => {
  it('round-trips KV values per plugin', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': ALL_GRANTS } });
    const core = wired(host);

    await expect(
      core.submit(makeCall({ method: 'storage.kv.set', args: { key: 'a', value: { x: 1 } } }))
        .promise,
    ).resolves.toEqual({ ok: true });
    await expect(
      core.submit(makeCall({ method: 'storage.kv.get', args: { key: 'a' } })).promise,
    ).resolves.toEqual({ value: { x: 1 } });
    await expect(
      core.submit(makeCall({ method: 'storage.kv.get', args: { key: 'missing' } })).promise,
    ).resolves.toEqual({ value: null });
    await expect(
      core.submit(makeCall({ method: 'storage.kv.list', args: {} })).promise,
    ).resolves.toEqual({ keys: ['a'] });
    await expect(
      core.submit(makeCall({ method: 'storage.kv.delete', args: { key: 'a' } })).promise,
    ).resolves.toEqual({ deleted: true });
    await expect(
      core.submit(makeCall({ method: 'storage.kv.delete', args: { key: 'a' } })).promise,
    ).resolves.toEqual({ deleted: false });
    expect(host.kvSnapshot('plugin-a')).toEqual({});
  });

  it('isolates KV stores between plugins', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ALL_GRANTS, 'plugin-b': ALL_GRANTS },
    });
    const core = wired(host);
    await core.submit(
      makeCall({
        method: 'storage.kv.set',
        args: { key: 'secret', value: 'only-a' },
      }),
    ).promise;
    await expect(
      core.submit(
        makeCall({
          method: 'storage.kv.get',
          args: { key: 'secret' },
          caller: { pluginId: 'plugin-b', installationId: 'inst-b', trustLevel: 'sandbox' },
        }),
      ).promise,
    ).resolves.toEqual({ value: null });
  });

  it('round-trips settings per plugin', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': ALL_GRANTS } });
    const core = wired(host);
    await expect(
      core.submit(
        makeCall({ method: 'settings.set', args: { path: 'general.temperature', value: 0.9 } }),
      ).promise,
    ).resolves.toEqual({ ok: true });
    await expect(
      core.submit(makeCall({ method: 'settings.get', args: { path: 'general.temperature' } }))
        .promise,
    ).resolves.toEqual({ value: 0.9 });
    await expect(
      core.submit(makeCall({ method: 'settings.get', args: { path: 'missing' } })).promise,
    ).resolves.toEqual({ value: null });
    expect(host.settingsSnapshot('plugin-a')).toEqual({ 'general.temperature': 0.9 });
  });

  it('denies operations whose capability is not granted', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['storage.kv'] },
    });
    const core = wired(host);
    await expect(
      core.submit(makeCall({ method: 'settings.set', args: { path: 'p', value: 1 } })).promise,
    ).rejects.toMatchObject({ code: BrokerErrorCode.CAPABILITY_DENIED });
    // storage.kv still works for the same plugin.
    await expect(core.submit(makeCall()).promise).resolves.toEqual({ value: null });
  });

  it('denies a capability/method mismatch (declared capability != catalog)', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': ALL_GRANTS } });
    const core = wired(host);
    await expect(
      core.submit(makeCall({ capability: { name: 'settings.read' } })).promise,
    ).rejects.toMatchObject({ code: BrokerErrorCode.POLICY_DENIED });
  });

  it('rejects unknown methods with PROTOCOL_UNSUPPORTED', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': ALL_GRANTS } });
    const core = wired(host);
    await expect(
      core.submit(makeCall({ method: 'no.such.op', capability: { name: 'storage.kv' } })).promise,
    ).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' });
  });

  it('rejects malformed operation args (defense in depth)', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': ALL_GRANTS } });
    const core = wired(host);
    await expectCode(
      core.submit(makeCall({ args: { key: 'x'.repeat(600) } })).promise,
      BrokerErrorCode.VALIDATION_FAILED,
    );
    await expectCode(
      core.submit(makeCall({ method: 'storage.kv.set', args: { key: '' } })).promise,
      BrokerErrorCode.VALIDATION_FAILED,
    );
  });

  it('supports runtime grant and host-side revoke', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': ['storage.kv'] } });
    const core = wired(host);
    expect(host.isGranted('plugin-a', 'settings.read')).toBe(false);

    host.grant('plugin-a', 'settings.read');
    expect(host.isGranted('plugin-a', 'settings.read')).toBe(true);
    await expect(
      core.submit(makeCall({ method: 'settings.get', args: { path: 'p' } })).promise,
    ).resolves.toEqual({ value: null });

    host.revoke('plugin-a', 'settings.read');
    expect(host.isGranted('plugin-a', 'settings.read')).toBe(false);
    await expectCode(
      core.submit(makeCall({ method: 'settings.get', args: { path: 'p' } })).promise,
      BrokerErrorCode.CAPABILITY_DENIED,
    );
  });
});

describe('memory host events channel (§18, ADR-0025)', () => {
  function eventsCall(args: Record<string, unknown>, deadlineAt?: number): BrokerCallRequest {
    return makeCall({
      method: 'events.replay',
      args,
      deadlineAt: deadlineAt ?? Date.now() + 10_000,
    });
  }

  it('replays buffered events from the beginning and continues from a cursor', async () => {
    const host = createMemoryHostExecutor({});
    const core = wired(host);
    host.emit('chat.message.created', { id: 1 });
    host.emit('chat.message.created', { id: 2 });

    await expect(
      core.submit(eventsCall({ name: 'chat.message.created' })).promise,
    ).resolves.toEqual({
      events: [
        { seq: 1, name: 'chat.message.created', emittedAt: expect.any(Number), payload: { id: 1 } },
        { seq: 2, name: 'chat.message.created', emittedAt: expect.any(Number), payload: { id: 2 } },
      ],
      nextCursor: 2,
    });

    host.emit('chat.message.created', { id: 3 });
    await expect(
      core.submit(eventsCall({ name: 'chat.message.created', cursor: 2 })).promise,
    ).resolves.toEqual({
      events: [
        { seq: 3, name: 'chat.message.created', emittedAt: expect.any(Number), payload: { id: 3 } },
      ],
      nextCursor: 3,
    });

    // Caught-up cursor: no new events, cursor preserved.
    await expect(
      core.submit(eventsCall({ name: 'chat.message.created', cursor: 3 })).promise,
    ).resolves.toEqual({ events: [], nextCursor: 3 });
  });

  it('is a core channel: replay works without any grants', async () => {
    const host = createMemoryHostExecutor({}); // no grants at all
    const core = wired(host);
    host.emit('app.ready', true);
    await expect(core.submit(eventsCall({ name: 'app.ready' })).promise).resolves.toMatchObject({
      events: [{ seq: 1, payload: true }],
    });
  });

  it('evicts the oldest events per name and expires cursors outside the window', async () => {
    const host = createMemoryHostExecutor({});
    const core = wired(host);
    for (let i = 1; i <= 130; i += 1) host.emit('metrics', i);

    // The per-name ring keeps the last 128 entries (seq 3..130); replay is
    // paginated by the default limit (64), so the first page is seq 3..66.
    const firstPage = (await core.submit(eventsCall({ name: 'metrics' })).promise) as {
      events: { seq: number }[];
      nextCursor: number;
    };
    expect(firstPage.events).toHaveLength(64);
    expect(firstPage.events[0]!.seq).toBe(3);
    expect(firstPage.nextCursor).toBe(66);

    const secondPage = (await core.submit(eventsCall({ name: 'metrics', cursor: 66 })).promise) as {
      events: { seq: number }[];
      nextCursor: number;
    };
    expect(secondPage.events).toHaveLength(64);
    expect(secondPage.events[0]!.seq).toBe(67);
    expect(secondPage.nextCursor).toBe(130);

    // A cursor below the evicted range points at lost events → expired.
    await expect(
      core.submit(eventsCall({ name: 'metrics', cursor: 1 })).promise,
    ).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    // A cursor at the eviction boundary continues losslessly (seq 3..66).
    await expect(
      core.submit(eventsCall({ name: 'metrics', cursor: 2, limit: 4 })).promise,
    ).resolves.toMatchObject({ nextCursor: 6 });
    // A caught-up cursor returns nothing new and preserves the cursor.
    await expect(
      core.submit(eventsCall({ name: 'metrics', cursor: 130 })).promise,
    ).resolves.toEqual({ events: [], nextCursor: 130 });
  });

  it('rejects a cursor ahead of the newest emitted event', async () => {
    const host = createMemoryHostExecutor({});
    const core = wired(host);
    host.emit('x', 1);
    await expect(core.submit(eventsCall({ name: 'x', cursor: 2 })).promise).rejects.toMatchObject({
      code: BrokerErrorCode.VALIDATION_FAILED,
    });
  });

  it('waits for the next event when the buffer is empty (bounded)', async () => {
    const host = createMemoryHostExecutor({});
    const controller = new AbortController();
    const started = host.policy.execute(
      eventsCall({ name: 'live', waitMs: 2000 }),
      controller.signal,
    );

    host.emit('live', 'tick');
    await expect(started).resolves.toMatchObject({
      events: [{ seq: 1, payload: 'tick' }],
      nextCursor: 1,
    });
    controller.abort();
  });

  it('clamps the wait to the broker deadline budget', async () => {
    const host = createMemoryHostExecutor({});
    const controller = new AbortController();
    const deadlineAt = Date.now() + 150;
    const startedAt = Date.now();
    const result = await host.policy.execute(
      eventsCall({ name: 'slow', waitMs: 5000 }, deadlineAt),
      controller.signal,
    );
    const elapsed = Date.now() - startedAt;
    expect(result).toEqual({ events: [], nextCursor: null });
    expect(elapsed).toBeLessThan(1000);
    controller.abort();
  });

  it('bounds concurrent waiters with SERVICE_UNAVAILABLE', async () => {
    const host = createMemoryHostExecutor({});
    const controllers: AbortController[] = [];
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 64; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      pending.push(
        host.policy
          .execute(eventsCall({ name: `w${i}`, waitMs: 5000 }), controller.signal)
          .catch(() => undefined),
      );
    }
    const denied = host.policy.execute(
      eventsCall({ name: 'overflow', waitMs: 5000 }),
      new AbortController().signal,
    );
    await expect(denied).rejects.toMatchObject({ code: BrokerErrorCode.SERVICE_UNAVAILABLE });
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
  });

  it('sweeps TTL-expired events and expires cursors pointing at them', async () => {
    let clock = 1_000_000;
    const host = createMemoryHostExecutor({ now: () => clock });
    const core = wired(host);
    host.emit('telemetry', 'a');
    host.emit('telemetry', 'b');
    host.emit('telemetry', 'c');

    clock += 61_000; // everything older than 60s
    await expect(core.submit(eventsCall({ name: 'telemetry' })).promise).resolves.toEqual({
      events: [],
      nextCursor: null,
    });

    // The swept events are gone: a cursor into them is expired.
    await expect(
      core.submit(eventsCall({ name: 'telemetry', cursor: 2 })).promise,
    ).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    expect(host.eventsSnapshot('telemetry')).toEqual([]);
  });

  it('evicts globally across names when the total ring cap is hit', () => {
    const host = createMemoryHostExecutor({});
    // 50 names × 100 events = 5000 > EVENTS_TOTAL(4096): the global FIFO cap
    // evicts the oldest entries across all names.
    for (let n = 0; n < 50; n += 1) {
      for (let i = 0; i < 100; i += 1) host.emit(`bulk-${n}`, i);
    }
    let total = 0;
    for (let n = 0; n < 50; n += 1) total += host.eventsSnapshot(`bulk-${n}`).length;
    expect(total).toBe(4096);
  });
});

describe('memory host events live delivery (§18, Stage F)', () => {
  it('pushes emitted events to subscriptions via the sink and drops dead ones', async () => {
    const pushed: { id: string; envelope: { seq: number; payload: unknown } }[] = [];
    const host = createMemoryHostExecutor({
      eventPushSink: (subscriptionId, envelope) => {
        pushed.push({
          id: subscriptionId,
          envelope: envelope as { seq: number; payload: unknown },
        });
        return true;
      },
    });
    const core = wired(host);

    const first = (await core.submit(
      makeCall({ method: 'events.subscribe', args: { name: 'live.tick' } }),
    ).promise) as { subscriptionId: string };
    expect(first.subscriptionId).toMatch(/^sub-/);
    expect(host.eventSubscriptionCount()).toBe(1);

    // Another plugin subscribes to a different name; its pushes go elsewhere.
    const second = (await core.submit(
      makeCall({
        method: 'events.subscribe',
        args: { name: 'other.tick' },
        caller: { pluginId: 'plugin-b', installationId: 'inst-b', trustLevel: 'sandbox' },
      }),
    ).promise) as { subscriptionId: string };
    expect(second.subscriptionId).not.toBe(first.subscriptionId);

    host.emit('live.tick', { n: 1 });
    host.emit('live.tick', { n: 2 });
    host.emit('other.tick', 99);
    // The sink is global: every subscription receives its own name's events.
    expect(pushed).toEqual([
      {
        id: first.subscriptionId,
        envelope: expect.objectContaining({ seq: 1, payload: { n: 1 } }),
      },
      {
        id: first.subscriptionId,
        envelope: expect.objectContaining({ seq: 2, payload: { n: 2 } }),
      },
      { id: second.subscriptionId, envelope: expect.objectContaining({ seq: 1, payload: 99 }) },
    ]);
    // The event core is global: the ring holds all names.
    expect(host.eventsSnapshot('live.tick')).toHaveLength(2);
    expect(host.eventsSnapshot('other.tick')).toHaveLength(1);
  });

  it('drops a subscription whose sink stops routing (worker death, self-cleaning)', async () => {
    let alive = true;
    const host = createMemoryHostExecutor({
      eventPushSink: () => alive,
    });
    const core = wired(host);
    const { subscriptionId } = (await core.submit(
      makeCall({ method: 'events.subscribe', args: { name: 'live.tick' } }),
    ).promise) as { subscriptionId: string };
    expect(subscriptionId).toMatch(/^sub-/);
    expect(host.eventSubscriptionCount()).toBe(1);

    host.emit('live.tick', 1);
    expect(host.eventSubscriptionCount()).toBe(1);

    alive = false; // worker terminated between emits
    host.emit('live.tick', 2);
    expect(host.eventSubscriptionCount()).toBe(0);
  });

  it('unsubscribes idempotently and only the owning plugin', async () => {
    const host = createMemoryHostExecutor({ eventPushSink: () => true });
    const core = wired(host);
    const a = (await core.submit(
      makeCall({ method: 'events.subscribe', args: { name: 'live.tick' } }),
    ).promise) as { subscriptionId: string };
    const b = (await core.submit(
      makeCall({
        method: 'events.subscribe',
        args: { name: 'live.tick' },
        caller: { pluginId: 'plugin-b', installationId: 'inst-b', trustLevel: 'sandbox' },
      }),
    ).promise) as { subscriptionId: string };
    expect(host.eventSubscriptionCount()).toBe(2);

    // A foreign plugin cannot unsubscribe plugin-a's subscription.
    await core.submit(
      makeCall({
        method: 'events.unsubscribe',
        args: { subscriptionId: a.subscriptionId },
        caller: { pluginId: 'plugin-b', installationId: 'inst-b', trustLevel: 'sandbox' },
      }),
    ).promise;
    expect(host.eventSubscriptionCount()).toBe(2);

    await core.submit(
      makeCall({ method: 'events.unsubscribe', args: { subscriptionId: a.subscriptionId } }),
    ).promise;
    expect(host.eventSubscriptionCount()).toBe(1);

    // Unknown ids are a no-op (idempotent close).
    await expect(
      core.submit(
        makeCall({ method: 'events.unsubscribe', args: { subscriptionId: 'nope-00000000' } }),
      ).promise,
    ).resolves.toEqual({ ok: true });
    expect(host.eventSubscriptionCount()).toBe(1);
    expect(b.subscriptionId).not.toBe(a.subscriptionId);
  });

  it('bounds subscriptions per plugin with SERVICE_UNAVAILABLE', async () => {
    const host = createMemoryHostExecutor({ eventPushSink: () => true });
    const core = wired(host);
    for (let i = 0; i < 8; i += 1) {
      await core.submit(makeCall({ method: 'events.subscribe', args: { name: `live.${i}` } }))
        .promise;
    }
    expect(host.eventSubscriptionCount()).toBe(8);
    await expect(
      core.submit(makeCall({ method: 'events.subscribe', args: { name: 'live.9' } })).promise,
    ).rejects.toMatchObject({ code: BrokerErrorCode.SERVICE_UNAVAILABLE });
  });

  it('validates subscribe args (core channel: no grants needed)', async () => {
    const host = createMemoryHostExecutor({ eventPushSink: () => true });
    const core = wired(host);
    await expect(
      core.submit(makeCall({ method: 'events.subscribe', args: { name: '' } })).promise,
    ).rejects.toMatchObject({ code: BrokerErrorCode.VALIDATION_FAILED });
    await expect(
      core.submit(makeCall({ method: 'events.subscribe', args: { name: 'x', cursor: 0 } })).promise,
    ).rejects.toMatchObject({ code: BrokerErrorCode.VALIDATION_FAILED });
    // Core channel: subscribe works without any grant.
    await expect(
      core.submit(makeCall({ method: 'events.subscribe', args: { name: 'x' } })).promise,
    ).resolves.toMatchObject({ subscriptionId: expect.stringMatching(/^sub-/) });
  });
});

/** Build a mock Response with a subset of the real Response API. */
function mockResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
  statusText = '',
): Response {
  const h = new Headers(headers);
  return {
    status,
    statusText,
    headers: h,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('memory host network fetch (§29, SSRF-hardened)', () => {
  const NETWORK_GRANTS = ['network.http'];

  function networkCall(url: string, extra: Partial<BrokerCallRequest> = {}): BrokerCallRequest {
    return makeCall({
      method: 'network.http.fetch',
      capability: { name: 'network.http' },
      args: { url },
      // Unique per call: concurrent in-flight submissions must not collide
      // on the broker's requestId (SEC-04 budget tests hold several open).
      requestId: `req-net-${Math.random().toString(36).slice(2, 10)}`,
      ...extra,
    });
  }

  it('round-trips a public fetch via injected fetchImpl', async () => {
    const fetchImpl = async (_url: string) => mockResponse(200, 'hello', { 'x-test': '1' });
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const core = wired(host);
    await expect(core.submit(networkCall('https://example.com')).promise).resolves.toEqual({
      status: 200,
      statusText: '',
      headers: { 'x-test': '1' },
      body: 'hello',
      url: 'https://example.com',
      redirects: [],
    });
  });

  it('enforces the per-plugin in-flight byte budget (SEC-04)', async () => {
    // Hold two fetches open (worst-case reservation = NETWORK_MAX_BODY_BYTES
    // each); a third concurrent fetch of the SAME plugin must fail with the
    // stable NETWORK_INFLIGHT_LIMIT before any body is read.
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/first')) await firstGate;
      if (url.endsWith('/second')) await secondGate;
      return mockResponse(200, 'ok');
    };
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const core = wired(host);
    const first = core.submit(networkCall('https://example.com/first'));
    const second = core.submit(networkCall('https://example.com/second'));
    // Both in flight: per-plugin budget (16 MiB) is exactly 2 × 8 MiB, so the
    // third concurrent fetch exceeds it.
    await expect(
      core.submit(networkCall('https://example.com/third')).promise,
    ).rejects.toMatchObject({ code: 'NETWORK_INFLIGHT_LIMIT' });
    releaseFirst?.();
    releaseSecond?.();
    await expect(first.promise).resolves.toMatchObject({ body: 'ok' });
    await expect(second.promise).resolves.toMatchObject({ body: 'ok' });
    // Budget released: a new fetch now succeeds.
    await expect(
      core.submit(networkCall('https://example.com/after')).promise,
    ).resolves.toMatchObject({ body: 'ok' });
  });

  it('enforces the global in-flight byte budget across plugins (SEC-04)', async () => {
    // Global budget = 64 MiB = 8 × 8 MiB worst-case reservations. Nine
    // plugins each holding one fetch open must trip the GLOBAL budget on the
    // ninth (each plugin alone stays under its per-plugin budget).
    const gates: Array<() => void> = [];
    let released = false;
    const fetchImpl = async () => {
      if (released) return mockResponse(200, 'ok');
      const gate = new Promise<void>((resolve) => gates.push(resolve));
      await gate;
      return mockResponse(200, 'ok');
    };
    const grants: Record<string, string[]> = {};
    for (let i = 0; i < 9; i += 1) grants[`plugin-${i}`] = NETWORK_GRANTS;
    grants['plugin-new'] = NETWORK_GRANTS;
    const host = createMemoryHostExecutor({
      grants,
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const core = wired(host);
    const submitted = Array.from({ length: 8 }, (_, i) =>
      core.submit(
        networkCall('https://example.com/x', {
          caller: {
            pluginId: `plugin-${i}`,
            installationId: `inst-${i}`,
            trustLevel: 'sandbox',
          },
        }),
      ),
    );
    // Deterministic: wait until all 8 have reserved their worst-case budget
    // (they are all parked inside fetchImpl), THEN submit the ninth — it must
    // fail on the GLOBAL budget (8 × 8 MiB = 64 MiB already reserved).
    for (let i = 0; gates.length < 8 && i < 500; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(gates.length).toBe(8);
    await expect(
      core.submit(
        networkCall('https://example.com/x', {
          caller: {
            pluginId: 'plugin-8',
            installationId: 'inst-8',
            trustLevel: 'sandbox',
          },
        }),
      ).promise,
    ).rejects.toMatchObject({ code: 'NETWORK_INFLIGHT_LIMIT' });
    for (const release of gates) release();
    released = true;
    await expect(Promise.all(submitted.map((s) => s.promise))).resolves.toHaveLength(8);
    // Global budget released: a fresh plugin fetch succeeds.
    await expect(
      core.submit(
        networkCall('https://example.com/y', {
          caller: { pluginId: 'plugin-new', installationId: 'inst-new', trustLevel: 'sandbox' },
        }),
      ).promise,
    ).resolves.toMatchObject({ body: 'ok' });
  });

  it('denies loopback destinations (§29.1.1)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
    });
    const core = wired(host);
    await expectCode(
      core.submit(networkCall('http://127.0.0.1/admin')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('denies bracketed IPv6 loopback without network.local (SEC-03)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
      dnsLookupImpl: async () => ['::1'],
    });
    const core = wired(host);
    // URL.hostname keeps the brackets on IPv6 hosts ("[::1]"); a classifier
    // that misses the bracket form labels it "public" — the SSRF bypass this
    // test pins shut.
    await expectCode(
      core.submit(networkCall('http://[::1]/admin')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('denies IPv4-mapped loopback literals without network.local (SEC-03)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
    });
    const core = wired(host);
    // Dotted-quad mapped form.
    await expectCode(
      core.submit(networkCall('http://[::ffff:127.0.0.1]/admin')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
    // Hex spelling is what URL parsing produces for the same address.
    await expectCode(
      core.submit(networkCall('http://[::ffff:7f00:1]/admin')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
    // A mapped private range must need network.private, not pass as public.
    await expectCode(
      core.submit(networkCall('http://[::ffff:10.0.0.1]/admin')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('denies RFC1918 private ranges', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
    });
    const core = wired(host);
    await expectCode(
      core.submit(networkCall('http://10.0.0.1/internal')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
    await expectCode(
      core.submit(networkCall('http://192.168.1.1/router')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
    await expectCode(
      core.submit(networkCall('http://172.16.0.1/corp')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('denies cloud metadata endpoint (169.254.169.254)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
    });
    const core = wired(host);
    await expectCode(
      core.submit(networkCall('http://169.254.169.254/latest/meta-data')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('denies non-http schemes (file:, ftp:)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
    });
    const core = wired(host);
    await expectCode(
      core.submit(networkCall('file:///etc/passwd')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('blocks DNS rebinding: hostname resolves to private IP (§29.1.2)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
      dnsLookupImpl: async () => ['10.0.0.5'],
    });
    const core = wired(host);
    await expectCode(
      core.submit(networkCall('https://rebinding.attacker.com')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('follows redirects and re-checks each target (§29.1.3)', async () => {
    let call = 0;
    const fetchImpl = async (url: string) => {
      call += 1;
      if (url === 'https://example.com') {
        return mockResponse(302, '', { location: 'https://api.example.com/v2' });
      }
      return mockResponse(200, 'final', { 'content-type': 'text/plain' });
    };
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const core = wired(host);
    const result = await core.submit(networkCall('https://example.com')).promise;
    expect(result).toMatchObject({
      status: 200,
      body: 'final',
      url: 'https://api.example.com/v2',
      redirects: ['https://api.example.com/v2'],
    });
    expect(call).toBe(2);
  });

  it('rejects a redirect to a forbidden target', async () => {
    const fetchImpl = async (url: string) => {
      if (url === 'https://example.com') {
        return mockResponse(302, '', { location: 'http://127.0.0.1/secret' });
      }
      return mockResponse(200, 'should-not-reach');
    };
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const core = wired(host);
    await expectCode(
      core.submit(networkCall('https://example.com')).promise,
      'NETWORK_REDIRECT_DENIED',
    );
  });

  it('returns the redirect response itself in manual mode', async () => {
    const fetchImpl = async () => mockResponse(302, '', { location: 'https://other.example.com' });
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const core = wired(host);
    const result = await core.submit(
      networkCall('https://example.com', {
        args: { url: 'https://example.com', redirect: 'manual' },
      }),
    ).promise;
    expect(result).toMatchObject({ status: 302, redirects: [] });
  });

  it('requires the network.http grant', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': [] },
      fetchImpl: async () => mockResponse(200, 'ok'),
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const core = wired(host);
    await expectCode(core.submit(networkCall('https://example.com')).promise, 'CAPABILITY_DENIED');
  });

  it('truncates oversized response bodies to the control-path cap', async () => {
    const big = 'x'.repeat(NETWORK_MAX_BODY_BYTES + 100);
    const fetchImpl = async () => mockResponse(200, big);
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const core = wired(host);
    const result = (await core.submit(networkCall('https://example.com')).promise) as {
      body: string;
    };
    expect(result.body.length).toBe(NETWORK_MAX_BODY_BYTES);
  });

  it('injects a secret-bound header inside the bound origin and wins on conflict (§29.1.5)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.push({
        url,
        headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) },
      });
      return mockResponse(200, 'hello');
    };
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
      networkSecrets: {
        'api-token': {
          origin: 'https://api.example.com',
          headers: { authorization: 'Bearer sekrit' },
        },
      },
    });
    const core = wired(host);
    await core.submit(
      networkCall('https://api.example.com/v1', {
        args: {
          url: 'https://api.example.com/v1',
          secretId: 'api-token',
          headers: { authorization: 'plugin-token' },
        },
      }),
    ).promise;
    expect(seen).toHaveLength(1);
    // The secret wins over a plugin-supplied conflicting header; the plugin
    // never sees the value (it is injected host-side at request time).
    expect(seen[0]?.headers['authorization']).toBe('Bearer sekrit');
  });

  it('rejects an unknown secret handle', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
      dnsLookupImpl: async () => ['93.184.216.34'],
      networkSecrets: {
        'api-token': { origin: 'https://api.example.com', headers: { authorization: 'x' } },
      },
    });
    const core = wired(host);
    await expectCode(
      core.submit(
        networkCall('https://api.example.com', {
          args: { url: 'https://api.example.com', secretId: 'missing-token' },
        }),
      ).promise,
      'NETWORK_SECRET_NOT_FOUND',
    );
  });

  it('rejects a secret used against a foreign origin (no use secret X + arbitrary Y)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
      dnsLookupImpl: async () => ['93.184.216.34'],
      networkSecrets: {
        'api-token': {
          origin: 'https://api.example.com',
          headers: { authorization: 'Bearer sekrit' },
        },
      },
    });
    const core = wired(host);
    await expectCode(
      core.submit(
        networkCall('https://attacker.example.net', {
          args: { url: 'https://attacker.example.net/x', secretId: 'api-token' },
        }),
      ).promise,
      'NETWORK_SECRET_ORIGIN_MISMATCH',
    );
  });

  it('drops the injected secret when a redirect leaves the bound origin (§29.1.5)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.push({
        url,
        headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) },
      });
      if (url === 'https://api.example.com/v1') {
        return mockResponse(302, '', { location: 'https://cdn.example.org/v2' });
      }
      return mockResponse(200, 'final');
    };
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': NETWORK_GRANTS },
      fetchImpl,
      dnsLookupImpl: async (hostname) =>
        hostname === 'api.example.com' ? ['93.184.216.34'] : ['93.184.216.35'],
      networkSecrets: {
        'api-token': {
          origin: 'https://api.example.com',
          headers: { authorization: 'Bearer sekrit' },
        },
      },
    });
    const core = wired(host);
    const result = (await core.submit(
      networkCall('https://api.example.com/v1', {
        args: { url: 'https://api.example.com/v1', secretId: 'api-token' },
      }),
    ).promise) as { redirects: string[] };
    expect(result.redirects).toEqual(['https://cdn.example.org/v2']);
    expect(seen).toHaveLength(2);
    // Bound hop: the secret is present.
    expect(seen[0]?.headers['authorization']).toBe('Bearer sekrit');
    // Redirect hop outside the bound origin: the secret never travels.
    expect(seen[1]?.headers['authorization']).toBeUndefined();
  });
});

describe('memory host network scope capabilities (§29.1.1)', () => {
  function networkCall(url: string, extra: Partial<BrokerCallRequest> = {}): BrokerCallRequest {
    return makeCall({
      method: 'network.http.fetch',
      capability: { name: 'network.http' },
      args: { url },
      ...extra,
    });
  }

  it('allows loopback when network.local is granted', async () => {
    const fetchImpl = async () => mockResponse(200, 'local-ok');
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.local'] },
      fetchImpl,
      dnsLookupImpl: async () => ['127.0.0.1'],
    });
    const core = wired(host);
    await expect(
      core.submit(networkCall('http://127.0.0.1/health')).promise,
    ).resolves.toMatchObject({ status: 200, body: 'local-ok' });
  });

  it('denies loopback without network.local (default scope)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http'] },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
      dnsLookupImpl: async () => ['127.0.0.1'],
    });
    const core = wired(host);
    await expectCode(
      core.submit(networkCall('http://127.0.0.1/health')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('allows RFC1918 when network.private is granted', async () => {
    const fetchImpl = async () => mockResponse(200, 'private-ok');
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.private'] },
      fetchImpl,
      dnsLookupImpl: async () => ['10.0.0.5'],
    });
    const core = wired(host);
    await expect(
      core.submit(networkCall('http://10.0.0.5/internal')).promise,
    ).resolves.toMatchObject({ status: 200, body: 'private-ok' });
  });

  it('denies RFC1918 without network.private', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.local'] },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
      dnsLookupImpl: async () => ['192.168.1.1'],
    });
    const core = wired(host);
    await expectCode(
      core.submit(networkCall('http://192.168.1.1/router')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('allows cloud metadata when network.metadata is granted', async () => {
    const fetchImpl = async () => mockResponse(200, 'metadata-ok');
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.metadata'] },
      fetchImpl,
      dnsLookupImpl: async () => ['169.254.169.254'],
    });
    const core = wired(host);
    await expect(
      core.submit(networkCall('http://169.254.169.254/latest/meta-data')).promise,
    ).resolves.toMatchObject({ status: 200, body: 'metadata-ok' });
  });

  it('denies cloud metadata with only network.private (metadata needs its own scope)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.private'] },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
      dnsLookupImpl: async () => ['169.254.169.254'],
    });
    const core = wired(host);
    await expectCode(
      core.submit(networkCall('http://169.254.169.254/latest/meta-data')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('classifies 169.254.170.2 (ECS metadata) as metadata scope', async () => {
    const fetchImpl = async () => mockResponse(200, 'ecs-metadata');
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.metadata'] },
      fetchImpl,
      dnsLookupImpl: async () => ['169.254.170.2'],
    });
    const core = wired(host);
    await expect(
      core.submit(networkCall('http://169.254.170.2/v2/metadata')).promise,
    ).resolves.toMatchObject({ status: 200, body: 'ecs-metadata' });
  });

  it('denies non-metadata link-local (169.254.1.1) with only network.metadata', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.metadata'] },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
      dnsLookupImpl: async () => ['169.254.1.1'],
    });
    const core = wired(host);
    // 169.254.1.1 is link-local but NOT a metadata endpoint → needs
    // network.private, not network.metadata.
    await expectCode(
      core.submit(networkCall('http://169.254.1.1/probe')).promise,
      'NETWORK_DESTINATION_DENIED',
    );
  });

  it('allows IPv6 loopback with network.local', async () => {
    const fetchImpl = async () => mockResponse(200, 'v6-local');
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.local'] },
      fetchImpl,
      dnsLookupImpl: async () => ['::1'],
    });
    const core = wired(host);
    await expect(core.submit(networkCall('http://[::1]/health')).promise).resolves.toMatchObject({
      status: 200,
      body: 'v6-local',
    });
  });

  it('re-checks scope on every redirect hop (§29.1.3)', async () => {
    const fetchImpl = async (url: string) => {
      if (url === 'https://example.com') {
        return mockResponse(302, '', { location: 'http://127.0.0.1/secret' });
      }
      return mockResponse(200, 'should-not-reach');
    };
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.private'] },
      fetchImpl,
      dnsLookupImpl: async (hostname) =>
        hostname === 'example.com' ? ['93.184.216.34'] : ['127.0.0.1'],
    });
    const core = wired(host);
    // The plugin has network.private but NOT network.local: the redirect to
    // 127.0.0.1 is denied because loopback needs network.local.
    await expectCode(
      core.submit(networkCall('https://example.com')).promise,
      'NETWORK_REDIRECT_DENIED',
    );
  });

  it('allows a redirect to a private IP when network.private is granted', async () => {
    const fetchImpl = async (url: string) => {
      if (url === 'https://example.com') {
        return mockResponse(302, '', { location: 'http://10.0.0.5/internal' });
      }
      return mockResponse(200, 'final');
    };
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http', 'network.private'] },
      fetchImpl,
      dnsLookupImpl: async (hostname) =>
        hostname === 'example.com' ? ['93.184.216.34'] : ['10.0.0.5'],
    });
    const core = wired(host);
    await expect(core.submit(networkCall('https://example.com')).promise).resolves.toMatchObject({
      status: 200,
      body: 'final',
      redirects: ['http://10.0.0.5/internal'],
    });
  });

  it('uses a custom networkScopeProvider when provided', async () => {
    const fetchImpl = async () => mockResponse(200, 'custom-scope');
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http'] },
      fetchImpl,
      dnsLookupImpl: async () => ['127.0.0.1'],
      networkScopeProvider: () => ({ local: true, private: false, metadata: false }),
    });
    const core = wired(host);
    // The grants map does NOT have network.local, but the custom provider
    // overrides the scope: loopback is admitted.
    await expect(core.submit(networkCall('http://127.0.0.1/x')).promise).resolves.toMatchObject({
      status: 200,
      body: 'custom-scope',
    });
  });

  it('includes requiredScope in the denied error details', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': ['network.http'] },
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
      dnsLookupImpl: async () => ['127.0.0.1'],
    });
    const core = wired(host);
    await expect(core.submit(networkCall('http://127.0.0.1/x')).promise).rejects.toMatchObject({
      code: 'NETWORK_DESTINATION_DENIED',
      details: { requiredScope: 'network.local', classification: 'local' },
    });
  });
});

describe('memory host models.list (§12 Models)', () => {
  const MODELS_GRANTS = ['models.list'];

  function modelsCall(providerId: string): BrokerCallRequest {
    return makeCall({
      method: 'models.list',
      capability: { name: 'models.list' },
      args: { providerId },
    });
  }

  it('returns the model list for a known provider', async () => {
    const modelsProvider = async (id: string) =>
      id === 'prov-a'
        ? [
            { id: 'gpt-4', name: 'GPT-4', contextLimit: 8192 },
            { id: 'gpt-3.5', name: 'GPT-3.5 Turbo' },
          ]
        : null;
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': MODELS_GRANTS },
      modelsProvider,
    });
    const core = wired(host);
    await expect(core.submit(modelsCall('prov-a')).promise).resolves.toEqual({
      models: [
        { id: 'gpt-4', name: 'GPT-4', contextLimit: 8192 },
        { id: 'gpt-3.5', name: 'GPT-3.5 Turbo' },
      ],
    });
  });

  it('rejects with NOT_FOUND for an unknown provider', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': MODELS_GRANTS },
      modelsProvider: async () => null,
    });
    const core = wired(host);
    await expectCode(core.submit(modelsCall('prov-missing')).promise, 'NOT_FOUND');
  });

  it('requires the models.list grant', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': [] },
      modelsProvider: async () => [{ id: 'x', name: 'X' }],
    });
    const core = wired(host);
    await expectCode(core.submit(modelsCall('prov-a')).promise, 'CAPABILITY_DENIED');
  });

  it('caps the returned model list at MODELS_MAX_LIST', async () => {
    const big = Array.from({ length: 300 }, (_, i) => ({
      id: `m-${i}`,
      name: `Model ${i}`,
    }));
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': MODELS_GRANTS },
      modelsProvider: async () => big,
    });
    const core = wired(host);
    const result = (await core.submit(modelsCall('prov-a')).promise) as {
      models: unknown[];
    };
    expect(result.models).toHaveLength(256);
  });
});

const SAMPLE_CHAT = {
  id: 'chat-1',
  characterId: 'char-1',
  personaId: null,
  title: 'Hello',
  activeBranchId: null,
  backgroundId: null,
  summary: '',
  messageCount: 3,
  createdAt: 1000,
  updatedAt: 2000,
  deletedAt: null,
  origin: null,
  parentChatId: null,
  sourceMessageId: null,
};

describe('memory host chats (§12 Application)', () => {
  const CHATS_GRANTS = ['chats.read'];

  function chatsListCall(args: Record<string, unknown> = {}): BrokerCallRequest {
    return makeCall({
      method: 'chats.list',
      capability: { name: 'chats.read' },
      args,
    });
  }

  function chatsReadCall(chatId: string): BrokerCallRequest {
    return makeCall({
      method: 'chats.read',
      capability: { name: 'chats.read' },
      args: { chatId },
    });
  }

  it('lists chats via the injectable chatsList', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': CHATS_GRANTS },
      chatsList: async () => ({
        items: [
          {
            id: 'chat-1',
            characterId: 'char-1',
            title: 'Hello',
            messageCount: 3,
            createdAt: 1000,
            updatedAt: 2000,
            origin: null,
            parentChatId: null,
            sourceMessageId: null,
          },
        ],
        nextCursor: 'next-page',
      }),
    });
    const core = wired(host);
    await expect(core.submit(chatsListCall({ limit: 10 })).promise).resolves.toEqual({
      items: [
        {
          id: 'chat-1',
          characterId: 'char-1',
          title: 'Hello',
          messageCount: 3,
          createdAt: 1000,
          updatedAt: 2000,
          origin: null,
          parentChatId: null,
          sourceMessageId: null,
        },
      ],
      nextCursor: 'next-page',
    });
  });

  it('reads a chat via the injectable chatsRead', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': CHATS_GRANTS },
      chatsRead: async (id) => (id === 'chat-1' ? SAMPLE_CHAT : null),
    });
    const core = wired(host);
    await expect(core.submit(chatsReadCall('chat-1')).promise).resolves.toEqual({
      chat: SAMPLE_CHAT,
    });
  });

  it('rejects with NOT_FOUND for a missing chat', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': CHATS_GRANTS },
      chatsRead: async () => null,
    });
    const core = wired(host);
    await expectCode(core.submit(chatsReadCall('chat-missing')).promise, 'NOT_FOUND');
  });

  it('requires the chats.read grant', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': [] },
      chatsList: async () => ({ items: [], nextCursor: null }),
    });
    const core = wired(host);
    await expectCode(core.submit(chatsListCall()).promise, 'CAPABILITY_DENIED');
  });

  it('caps the returned chat list at CHATS_MAX_LIST', async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: `chat-${i}`,
      characterId: null,
      title: `Chat ${i}`,
      messageCount: 0,
      createdAt: 1,
      updatedAt: 1,
      origin: null,
      parentChatId: null,
      sourceMessageId: null,
    }));
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': CHATS_GRANTS },
      chatsList: async () => ({ items, nextCursor: null }),
    });
    const core = wired(host);
    const result = (await core.submit(chatsListCall()).promise) as { items: unknown[] };
    expect(result.items).toHaveLength(200);
  });
});

const SAMPLE_CHARACTER = {
  id: 'char-1',
  name: 'Alice',
  avatar: null,
  description: 'A character',
  personality: '',
  scenario: '',
  firstMessage: 'Hello',
  exampleDialogues: '',
  systemPrompt: null,
  postHistoryInstructions: null,
  creator: null,
  creatorNotes: null,
  tags: ['fantasy'],
  ext: {},
  createdAt: 1000,
  updatedAt: 2000,
  lastUsedAt: null,
  deletedAt: null,
};

describe('memory host characters (§12 Application)', () => {
  const CHARACTERS_GRANTS = ['characters.read'];

  function charactersListCall(args: Record<string, unknown> = {}): BrokerCallRequest {
    return makeCall({
      method: 'characters.list',
      capability: { name: 'characters.read' },
      args,
    });
  }

  function charactersReadCall(characterId: string): BrokerCallRequest {
    return makeCall({
      method: 'characters.read',
      capability: { name: 'characters.read' },
      args: { characterId },
    });
  }

  it('lists characters via the injectable charactersList', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': CHARACTERS_GRANTS },
      charactersList: async () => ({
        items: [
          {
            id: 'char-1',
            name: 'Alice',
            avatar: null,
            description: 'A character',
            tags: ['fantasy'],
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
        nextCursor: 'next-page',
      }),
    });
    const core = wired(host);
    await expect(core.submit(charactersListCall({ limit: 10 })).promise).resolves.toEqual({
      items: [
        {
          id: 'char-1',
          name: 'Alice',
          avatar: null,
          description: 'A character',
          tags: ['fantasy'],
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
      nextCursor: 'next-page',
    });
  });

  it('reads a character via the injectable charactersRead', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': CHARACTERS_GRANTS },
      charactersRead: async (id) => (id === 'char-1' ? SAMPLE_CHARACTER : null),
    });
    const core = wired(host);
    await expect(core.submit(charactersReadCall('char-1')).promise).resolves.toEqual({
      character: SAMPLE_CHARACTER,
    });
  });

  it('rejects with NOT_FOUND for a missing character', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': CHARACTERS_GRANTS },
      charactersRead: async () => null,
    });
    const core = wired(host);
    await expectCode(core.submit(charactersReadCall('char-missing')).promise, 'NOT_FOUND');
  });

  it('requires the characters.read grant', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': [] },
      charactersList: async () => ({ items: [], nextCursor: null }),
    });
    const core = wired(host);
    await expectCode(core.submit(charactersListCall()).promise, 'CAPABILITY_DENIED');
  });

  it('caps the returned character list at CHARACTERS_MAX_LIST', async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: `char-${i}`,
      name: `Character ${i}`,
      avatar: null,
      description: '',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }));
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': CHARACTERS_GRANTS },
      charactersList: async () => ({ items, nextCursor: null }),
    });
    const core = wired(host);
    const result = (await core.submit(charactersListCall()).promise) as { items: unknown[] };
    expect(result.items).toHaveLength(200);
  });
});

const SAMPLE_LOREBOK = {
  id: 'book-1',
  name: 'World',
  description: 'A lorebook',
  characterId: null,
  metadata: {},
  createdAt: 1000,
  updatedAt: 2000,
};

const SAMPLE_LOREBOK_ENTRY = {
  id: 'entry-1',
  lorebookId: 'book-1',
  keys: ['castle'],
  secondaryKeys: [],
  content: 'The castle is old.',
  enabled: true,
  position: 1,
  constant: false,
  selective: false,
  metadata: {},
  createdAt: 1000,
  updatedAt: 2000,
};

describe('memory host lorebook (§12 Application)', () => {
  const LOREBOK_GRANTS = ['lorebook.read'];

  function lorebookListCall(args: Record<string, unknown> = {}): BrokerCallRequest {
    return makeCall({
      method: 'lorebook.list',
      capability: { name: 'lorebook.read' },
      args,
    });
  }

  function lorebookReadCall(bookId: string): BrokerCallRequest {
    return makeCall({
      method: 'lorebook.read',
      capability: { name: 'lorebook.read' },
      args: { bookId },
    });
  }

  function lorebookEntriesCall(bookId: string): BrokerCallRequest {
    return makeCall({
      method: 'lorebook.entries',
      capability: { name: 'lorebook.read' },
      args: { bookId },
    });
  }

  it('lists lorebooks via the injectable lorebooksList', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': LOREBOK_GRANTS },
      lorebooksList: async () => ({
        items: [SAMPLE_LOREBOK],
        nextCursor: 'next-page',
      }),
    });
    const core = wired(host);
    await expect(core.submit(lorebookListCall({ limit: 10 })).promise).resolves.toEqual({
      items: [SAMPLE_LOREBOK],
      nextCursor: 'next-page',
    });
  });

  it('passes the characterId filter to the lorebook list query', async () => {
    let received: { characterId?: string } = {};
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': LOREBOK_GRANTS },
      lorebooksList: async (query) => {
        received = query;
        return { items: [], nextCursor: null };
      },
    });
    const core = wired(host);
    await core.submit(lorebookListCall({ characterId: 'char-1' })).promise;
    expect(received.characterId).toBe('char-1');
  });

  it('reads a lorebook via the injectable lorebookRead', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': LOREBOK_GRANTS },
      lorebookRead: async (id) => (id === 'book-1' ? SAMPLE_LOREBOK : null),
    });
    const core = wired(host);
    await expect(core.submit(lorebookReadCall('book-1')).promise).resolves.toEqual({
      book: SAMPLE_LOREBOK,
    });
  });

  it('rejects with NOT_FOUND for a missing lorebook', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': LOREBOK_GRANTS },
      lorebookRead: async () => null,
    });
    const core = wired(host);
    await expectCode(core.submit(lorebookReadCall('book-missing')).promise, 'NOT_FOUND');
  });

  it('lists entries via the injectable lorebookEntries', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': LOREBOK_GRANTS },
      lorebookEntries: async (id) => (id === 'book-1' ? [SAMPLE_LOREBOK_ENTRY] : null),
    });
    const core = wired(host);
    await expect(core.submit(lorebookEntriesCall('book-1')).promise).resolves.toEqual({
      items: [SAMPLE_LOREBOK_ENTRY],
    });
  });

  it('rejects with NOT_FOUND for entries of a missing lorebook', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': LOREBOK_GRANTS },
      lorebookEntries: async () => null,
    });
    const core = wired(host);
    await expectCode(core.submit(lorebookEntriesCall('book-missing')).promise, 'NOT_FOUND');
  });

  it('requires the lorebook.read grant', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': [] },
      lorebooksList: async () => ({ items: [], nextCursor: null }),
    });
    const core = wired(host);
    await expectCode(core.submit(lorebookListCall()).promise, 'CAPABILITY_DENIED');
  });

  it('caps the returned lorebook list at LOREBOK_MAX_LIST', async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: `book-${i}`,
      name: `Book ${i}`,
      description: '',
      characterId: null,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }));
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': LOREBOK_GRANTS },
      lorebooksList: async () => ({ items, nextCursor: null }),
    });
    const core = wired(host);
    const result = (await core.submit(lorebookListCall()).promise) as { items: unknown[] };
    expect(result.items).toHaveLength(200);
  });

  it('caps the returned entry list at LOREBOK_MAX_ENTRIES', async () => {
    const items = Array.from({ length: 1500 }, (_, i) => ({
      id: `entry-${i}`,
      lorebookId: 'book-1',
      keys: ['k'],
      secondaryKeys: [],
      content: 'c',
      enabled: true,
      position: i,
      constant: false,
      selective: false,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }));
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': LOREBOK_GRANTS },
      lorebookEntries: async () => items,
    });
    const core = wired(host);
    const result = (await core.submit(lorebookEntriesCall('book-1')).promise) as {
      items: unknown[];
    };
    expect(result.items).toHaveLength(1000);
  });
});

describe('memory host core DB (§31)', () => {
  const DB_GRANTS = ['database.core.read'];

  function dbQueryCall(args: Record<string, unknown>): BrokerCallRequest {
    return makeCall({
      method: 'database.core.query',
      capability: { name: 'database.core.read' },
      args,
    });
  }

  it('runs a read query via the injectable dbQuery', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': DB_GRANTS },
      dbQuery: async ({ params }) => ({
        columns: ['id', 'name'],
        rows: [[1, 'Alice'], ...params.map((p) => [2, p])],
      }),
    });
    const core = wired(host);
    await expect(
      core.submit(dbQueryCall({ sql: 'SELECT id, name FROM characters', params: ['a'] })).promise,
    ).resolves.toEqual({
      columns: ['id', 'name'],
      rows: [
        [1, 'Alice'],
        [2, 'a'],
      ],
    });
  });

  it('rejects write statements with POLICY_DENIED before delegation', async () => {
    let delegated = 0;
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': DB_GRANTS },
      dbQuery: async () => {
        delegated += 1;
        return { columns: [], rows: [] };
      },
    });
    const core = wired(host);
    for (const sql of [
      'INSERT INTO characters (name) VALUES (?)',
      'UPDATE characters SET name = ?',
      'DELETE FROM characters',
      'DROP TABLE characters',
      'CREATE TABLE x (id INTEGER)',
      'ALTER TABLE characters ADD COLUMN x',
      'VACUUM',
      'REINDEX',
      "ATTACH ':memory:' AS other",
      'PRAGMA journal_mode = DELETE',
    ]) {
      await expectCode(core.submit(dbQueryCall({ sql })).promise, 'POLICY_DENIED');
    }
    expect(delegated).toBe(0);
  });

  it('rejects multi-statement and non-SELECT prefixes with POLICY_DENIED', async () => {
    let delegated = 0;
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': DB_GRANTS },
      dbQuery: async () => {
        delegated += 1;
        return { columns: [], rows: [] };
      },
    });
    const core = wired(host);
    await expectCode(
      core.submit(dbQueryCall({ sql: 'SELECT 1; SELECT 2' })).promise,
      'POLICY_DENIED',
    );
    await expectCode(
      core.submit(dbQueryCall({ sql: 'PRAGMA table_info(characters)' })).promise,
      'POLICY_DENIED',
    );
    await expectCode(
      core.submit(dbQueryCall({ sql: 'EXPLAIN SELECT 1' })).promise,
      'POLICY_DENIED',
    );
    expect(delegated).toBe(0);
  });

  it('allows read-only CTE queries and pragma table functions', async () => {
    const seen: string[] = [];
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': DB_GRANTS },
      dbQuery: async ({ sql }) => {
        seen.push(sql);
        return { columns: ['ok'], rows: [[1]] };
      },
    });
    const core = wired(host);
    await expect(
      core.submit(
        dbQueryCall({
          sql: 'WITH latest AS (SELECT id FROM chats ORDER BY updatedAt DESC LIMIT 5) SELECT * FROM latest',
        }),
      ).promise,
    ).resolves.toEqual({ columns: ['ok'], rows: [[1]] });
    await expect(
      core.submit(dbQueryCall({ sql: "SELECT name FROM pragma_table_info('characters')" })).promise,
    ).resolves.toEqual({ columns: ['ok'], rows: [[1]] });
    expect(seen).toHaveLength(2);
  });

  it('rejects non-primitive cells with VALIDATION_FAILED', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': DB_GRANTS },
      dbQuery: async () => ({
        columns: ['blob'],
        rows: [[new Uint8Array([1, 2, 3])]],
      }),
    });
    const core = wired(host);
    await expectCode(
      core.submit(dbQueryCall({ sql: 'SELECT data FROM files' })).promise,
      'VALIDATION_FAILED',
    );
  });

  it('caps rows and columns at the database bounds', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => [i]);
    const columns = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': DB_GRANTS },
      dbQuery: async () => ({ columns, rows }),
    });
    const core = wired(host);
    const result = (await core.submit(dbQueryCall({ sql: 'SELECT * FROM big' })).promise) as {
      columns: unknown[];
      rows: unknown[][];
    };
    expect(result.columns).toHaveLength(64);
    expect(result.rows).toHaveLength(1000);
  });

  it('requires the database.core.read grant', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': [] },
      dbQuery: async () => ({ columns: [], rows: [] }),
    });
    const core = wired(host);
    await expectCode(core.submit(dbQueryCall({ sql: 'SELECT 1' })).promise, 'CAPABILITY_DENIED');
  });
});

// ---- §30 Files API (Stage E) ----

const FILE_GRANTS = ['files.plugin'];
const FILES_HOST = { grants: { 'plugin-a': FILE_GRANTS } };

function fileCall(method: string, args: Record<string, unknown>): BrokerCallRequest {
  return makeCall({
    method,
    args,
    capability: { name: 'files.plugin' },
  });
}

describe('files API (§30)', () => {
  it('round-trips write/read/stat through the plugin root', async () => {
    const host = createMemoryHostExecutor(FILES_HOST);
    const core = wired(host);
    await expect(
      core.submit(fileCall('files.write', { path: 'notes/a.txt', content: 'hello' })).promise,
    ).resolves.toEqual({ ok: true });
    await expect(
      core.submit(fileCall('files.read', { path: 'notes/a.txt' })).promise,
    ).resolves.toEqual({ content: 'hello' });
    await expect(
      core.submit(fileCall('files.stat', { path: 'notes/a.txt' })).promise,
    ).resolves.toEqual({ kind: 'file', size: 5 });
    await expect(core.submit(fileCall('files.stat', { path: 'notes' })).promise).resolves.toEqual({
      kind: 'directory',
      size: 0,
    });
  });

  it('lists entries without symlinks and without the host root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neotavern-files-list-'));
    try {
      const host = createMemoryHostExecutor({
        grants: { 'plugin-a': FILE_GRANTS },
        filesRoot: () => root,
      });
      const core = wired(host);
      await core.submit(fileCall('files.write', { path: 'a.txt', content: 'x' })).promise;
      await core.submit(fileCall('files.write', { path: 'b.txt', content: 'y' })).promise;
      await expect(core.submit(fileCall('files.list', { path: '.' })).promise).resolves.toEqual({
        entries: ['a.txt', 'b.txt'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renames and removes within the plugin root', async () => {
    const host = createMemoryHostExecutor(FILES_HOST);
    const core = wired(host);
    await core.submit(fileCall('files.write', { path: 'a.txt', content: 'x' })).promise;
    await expect(
      core.submit(fileCall('files.rename', { from: 'a.txt', to: 'sub/b.txt' })).promise,
    ).resolves.toEqual({ ok: true });
    await expect(
      core.submit(fileCall('files.read', { path: 'sub/b.txt' })).promise,
    ).resolves.toEqual({ content: 'x' });
    await expect(core.submit(fileCall('files.remove', { path: 'sub' })).promise).resolves.toEqual({
      ok: true,
    });
    await expectCode(
      core.submit(fileCall('files.read', { path: 'sub/b.txt' })).promise,
      'NOT_FOUND',
    );
  });

  it('rejects traversal, absolute paths and backslashes (§30)', async () => {
    const host = createMemoryHostExecutor(FILES_HOST);
    const core = wired(host);
    for (const path of [
      '../secret.txt',
      'a/../../secret.txt',
      '/etc/passwd',
      'C:\\windows',
      'a\\b.txt',
      'a/./b.txt',
    ]) {
      await expectCode(
        core.submit(fileCall('files.read', { path })).promise,
        BrokerErrorCode.VALIDATION_FAILED,
      );
    }
  });

  it('rejects a symlink escaping the plugin root (§30)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'neotavern-files-outside-'));
    const root = mkdtempSync(join(tmpdir(), 'neotavern-files-root-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'sensitive');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      const host = createMemoryHostExecutor({
        grants: { 'plugin-a': FILE_GRANTS },
        filesRoot: () => root,
      });
      const core = wired(host);
      await expectCode(
        core.submit(fileCall('files.read', { path: 'link.txt' })).promise,
        BrokerErrorCode.VALIDATION_FAILED,
      );
      // The symlink is visible but never resolvable: list filters it out.
      await expect(core.submit(fileCall('files.list', { path: '.' })).promise).resolves.toEqual({
        entries: [],
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a configured plugin root reached through a directory symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neotavern-files-canonical-'));
    const alias = `${root}-alias`;
    try {
      symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const host = createMemoryHostExecutor({
        grants: { 'plugin-a': FILE_GRANTS },
        filesRoot: () => alias,
      });
      const core = wired(host);
      await expect(
        core.submit(fileCall('files.write', { path: 'notes/a.txt', content: 'hello' })).promise,
      ).resolves.toEqual({ ok: true });
      await expect(
        core.submit(fileCall('files.read', { path: 'notes/a.txt' })).promise,
      ).resolves.toEqual({ content: 'hello' });
    } finally {
      rmSync(alias, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects writes through a directory symlink that escapes the plugin root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'neotavern-files-write-outside-'));
    const root = mkdtempSync(join(tmpdir(), 'neotavern-files-write-root-'));
    try {
      symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      const host = createMemoryHostExecutor({
        grants: { 'plugin-a': FILE_GRANTS },
        filesRoot: () => root,
      });
      const core = wired(host);
      await expectCode(
        core.submit(fileCall('files.write', { path: 'escape/secret.txt', content: 'blocked' }))
          .promise,
        BrokerErrorCode.VALIDATION_FAILED,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects reads of files above the content bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neotavern-files-big-'));
    try {
      const host = createMemoryHostExecutor({
        grants: { 'plugin-a': FILE_GRANTS },
        filesRoot: () => root,
      });
      const core = wired(host);
      await core.submit(fileCall('files.write', { path: 'a.txt', content: 'x' })).promise;
      // Grow the file behind the executor's back past the 4 MiB bound.
      writeFileSync(join(root, 'a.txt'), 'x'.repeat(4 * 1024 * 1024 + 1));
      await expectCode(
        core.submit(fileCall('files.read', { path: 'a.txt' })).promise,
        'FILE_TOO_LARGE',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates plugin roots from each other', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': FILE_GRANTS, 'plugin-b': FILE_GRANTS },
    });
    const core = wired(host);
    await core.submit(
      makeCall({
        caller: { pluginId: 'plugin-a', installationId: 'inst-a', trustLevel: 'sandbox' },
        method: 'files.write',
        args: { path: 'a.txt', content: 'mine' },
        capability: { name: 'files.plugin' },
      }),
    ).promise;
    await expect(
      core.submit(
        makeCall({
          caller: { pluginId: 'plugin-b', installationId: 'inst-b', trustLevel: 'sandbox' },
          method: 'files.read',
          args: { path: 'a.txt' },
          capability: { name: 'files.plugin' },
        }),
      ).promise,
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires the files.plugin grant', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': [] } });
    const core = wired(host);
    await expectCode(
      core.submit(fileCall('files.read', { path: 'a.txt' })).promise,
      'CAPABILITY_DENIED',
    );
  });
});

// ---- §19/§27 Jobs API (Stage E) ----

const JOBS_GRANTS = ['jobs.background'];

function jobCall(method: string, args: Record<string, unknown>): BrokerCallRequest {
  return makeCall({ method, args, capability: { name: 'jobs.background' } });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('jobs API (§19/§27)', () => {
  it('registers, lists and cancels jobs per plugin', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': JOBS_GRANTS } });
    const core = wired(host);
    const registered = (await core.submit(
      jobCall('jobs.register', { name: 'sync', intervalMs: 60000 }),
    ).promise) as { jobId: string };
    expect(registered.jobId).toMatch(/^job-/);
    const listed = (await core.submit(jobCall('jobs.list', {})).promise) as {
      jobs: Array<{ jobId: string; name: string }>;
    };
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0]?.name).toBe('sync');
    await expect(
      core.submit(jobCall('jobs.cancel', { jobId: registered.jobId })).promise,
    ).resolves.toEqual({ ok: true });
    const after = (await core.submit(jobCall('jobs.list', {})).promise) as {
      jobs: unknown[];
    };
    expect(after.jobs).toHaveLength(0);
  });

  it('requires exactly one of intervalMs or atMs', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': JOBS_GRANTS } });
    const core = wired(host);
    await expectCode(
      core.submit(jobCall('jobs.register', { name: 'x' })).promise,
      'VALIDATION_FAILED',
    );
    await expectCode(
      core.submit(jobCall('jobs.register', { name: 'x', intervalMs: 1000, atMs: 1000 })).promise,
      'VALIDATION_FAILED',
    );
  });

  it('fires one-shot jobs through the push sink', async () => {
    const fired: Array<{ jobId: string; name: string; scheduledAt: number }> = [];
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': JOBS_GRANTS },
      jobPushSink: (_pluginId, envelope) => {
        fired.push(envelope);
        return true;
      },
    });
    const core = wired(host);
    const { jobId } = (await core.submit(
      jobCall('jobs.register', { name: 'once', atMs: 50, payload: { n: 1 } }),
    ).promise) as { jobId: string };
    await sleep(250);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ jobId, name: 'once', payload: { n: 1 } });
    // One-shot jobs self-remove after firing.
    const listed = (await core.submit(jobCall('jobs.list', {})).promise) as {
      jobs: unknown[];
    };
    expect(listed.jobs).toHaveLength(0);
  });

  it('fires repeating jobs repeatedly until cancelled', async () => {
    let count = 0;
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': JOBS_GRANTS },
      jobPushSink: () => {
        count += 1;
        return true;
      },
    });
    const core = wired(host);
    const { jobId } = (await core.submit(
      jobCall('jobs.register', { name: 'tick', intervalMs: 100 }),
    ).promise) as { jobId: string };
    await sleep(300);
    expect(count).toBeGreaterThanOrEqual(2);
    await core.submit(jobCall('jobs.cancel', { jobId })).promise;
    const before = count;
    await sleep(200);
    expect(count).toBe(before);
  });

  it('cancels plugin jobs on revoke (§10.2)', async () => {
    let count = 0;
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': JOBS_GRANTS },
      jobPushSink: () => {
        count += 1;
        return true;
      },
    });
    const core = wired(host);
    await core.submit(jobCall('jobs.register', { name: 'tick', intervalMs: 100 })).promise;
    await sleep(150);
    expect(count).toBeGreaterThanOrEqual(1);
    host.revoke('plugin-a', 'jobs.background');
    const before = count;
    await sleep(200);
    expect(count).toBe(before);
  });

  it('caps registered jobs per plugin', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': JOBS_GRANTS } });
    const core = wired(host);
    for (let i = 0; i < 8; i += 1) {
      await core.submit(jobCall('jobs.register', { name: `j${i}`, intervalMs: 60000 })).promise;
    }
    await expectCode(
      core.submit(jobCall('jobs.register', { name: 'j9', intervalMs: 60000 })).promise,
      'SERVICE_UNAVAILABLE',
    );
  });

  it('requires the jobs.background grant', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': [] } });
    const core = wired(host);
    await expectCode(
      core.submit(jobCall('jobs.register', { name: 'x', intervalMs: 60000 })).promise,
      'CAPABILITY_DENIED',
    );
  });
});

// ---- §34 Services API (Stage E) ----

const SVC_PROVIDER_GRANTS = ['services.provide', 'services.connect'];

let svcSeq = 0;
function svcCall(
  pluginId: string,
  method: string,
  args: Record<string, unknown>,
): BrokerCallRequest {
  svcSeq += 1;
  return makeCall({
    requestId: `req-${pluginId}-${svcSeq}`,
    method,
    args,
    caller: { pluginId, installationId: `inst-${pluginId}`, trustLevel: 'sandbox' },
    capability: { name: METHOD_CAPABILITY[method] ?? 'services.connect' },
    causalChain: [],
  });
}

describe('services API (§34)', () => {
  it('provides a service and connects with a round-trip through the sink', async () => {
    const pushed: SdkServiceCallEnvelope[] = [];
    const host = createMemoryHostExecutor({
      grants: {
        'plugin-a': SVC_PROVIDER_GRANTS,
        'plugin-b': SVC_PROVIDER_GRANTS,
      },
      serviceCallSink: (_pluginId, envelope) => {
        pushed.push(envelope);
        return true;
      },
    });
    const core = wired(host);
    const provided = (await core.submit(
      svcCall('plugin-b', 'services.provide', {
        name: 'calc',
        version: '1.0.0',
        methods: ['double'],
      }),
    ).promise) as { serviceId: string };
    expect(provided.serviceId).toMatch(/^svc-/);

    const connect = core.submit(
      svcCall('plugin-a', 'services.connect', {
        name: 'calc',
        version: '1.0.0',
        method: 'double',
        args: { n: 21 },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      method: 'double',
      args: { n: 21 },
      chain: ['plugin-a'],
    });
    const callId = pushed[0]?.callId;
    expect(typeof callId).toBe('string');
    const settled = await core.submit(
      svcCall('plugin-b', 'services.respond', {
        callId,
        ok: true,
        result: { value: 42 },
      }),
    ).promise;
    expect(settled).toEqual({ ok: true });
    await expect(connect.promise).resolves.toEqual({ result: { value: 42 } });
  });

  it('rejects a connect whose provider is already on the causal chain (§26.2.1)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': SVC_PROVIDER_GRANTS, 'plugin-b': SVC_PROVIDER_GRANTS },
      serviceCallSink: () => true,
    });
    const core = wired(host);
    await core.submit(
      svcCall('plugin-b', 'services.provide', {
        name: 'calc',
        version: '1.0.0',
        methods: ['double'],
      }),
    ).promise;
    // plugin-a → plugin-b → plugin-a: the provider (plugin-b) is NOT in the
    // chain yet, so the first hop is fine…
    const first = core.submit(
      makeCall({
        requestId: 'req-cycle-a',
        method: 'services.connect',
        args: { name: 'calc', version: '1.0.0', method: 'double' },
        capability: { name: 'services.connect' },
        causalChain: [],
        deadlineAt: Date.now() + 200,
      }),
    );
    // …but plugin-b calling back into a service provided by plugin-a with
    // chain [plugin-a, plugin-b] is a cycle.
    await expectCode(
      core.submit(
        makeCall({
          requestId: 'req-cycle-b',
          method: 'services.connect',
          args: { name: 'echo', version: '1.0.0', method: 'pong' },
          caller: { pluginId: 'plugin-b', installationId: 'inst-b', trustLevel: 'sandbox' },
          capability: { name: 'services.connect' },
          causalChain: ['plugin-a', 'plugin-b'],
        }),
      ).promise,
      'SERVICE_CALL_CYCLE',
    );
    await core.submit(
      svcCall('plugin-a', 'services.provide', {
        name: 'echo',
        version: '1.0.0',
        methods: ['pong'],
      }),
    ).promise;
    // plugin-a → plugin-b → plugin-a: plugin-a is on the chain [plugin-a]
    // pushed to plugin-b; when plugin-b calls back, the provider plugin-a is
    // already in the chain.
    const second = core.submit(
      makeCall({
        requestId: 'req-cycle-c',
        method: 'services.connect',
        args: { name: 'echo', version: '1.0.0', method: 'pong' },
        caller: { pluginId: 'plugin-b', installationId: 'inst-b', trustLevel: 'sandbox' },
        capability: { name: 'services.connect' },
        causalChain: ['plugin-a'],
      }),
    );
    await expectCode(second.promise, 'SERVICE_CALL_CYCLE');
    // Nobody answers the first hop (sink stub), so it expires on its
    // deadline — the pending path is settled, not leaked.
    await expectCode(first.promise, 'OPERATION_DEADLINE');
  });

  it('fails connect with NOT_FOUND / VALIDATION_FAILED and provider-down', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': SVC_PROVIDER_GRANTS },
      serviceCallSink: () => false,
    });
    const core = wired(host);
    await expectCode(
      core.submit(
        svcCall('plugin-a', 'services.connect', {
          name: 'nope',
          version: '1.0.0',
          method: 'x',
        }),
      ).promise,
      'NOT_FOUND',
    );
    await core.submit(
      svcCall('plugin-a', 'services.provide', {
        name: 'calc',
        version: '1.0.0',
        methods: ['double'],
      }),
    ).promise;
    await expectCode(
      core.submit(
        svcCall('plugin-a', 'services.connect', {
          name: 'calc',
          version: '1.0.0',
          method: 'missing',
        }),
      ).promise,
      'VALIDATION_FAILED',
    );
    // Provider worker gone: the sink refuses the push.
    await expectCode(
      core.submit(
        svcCall('plugin-a', 'services.connect', {
          name: 'calc',
          version: '1.0.0',
          method: 'double',
        }),
      ).promise,
      'SERVICE_UNAVAILABLE',
    );
  });

  it('rejects a duplicate name@version and foreign responds', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': SVC_PROVIDER_GRANTS, 'plugin-b': SVC_PROVIDER_GRANTS },
      serviceCallSink: () => true,
    });
    const core = wired(host);
    await core.submit(
      svcCall('plugin-a', 'services.provide', {
        name: 'calc',
        version: '1.0.0',
        methods: ['double'],
      }),
    ).promise;
    await expectCode(
      core.submit(
        svcCall('plugin-b', 'services.provide', {
          name: 'calc',
          version: '1.0.0',
          methods: ['double'],
        }),
      ).promise,
      'SERVICE_UNAVAILABLE',
    );
    // Unknown callId: idempotent { ok: false }.
    await expect(
      core.submit(svcCall('plugin-b', 'services.respond', { callId: 'sc-nope', ok: true })).promise,
    ).resolves.toEqual({ ok: false });
  });

  it('settles pending calls when the provider is revoked (§10.2)', async () => {
    const pushed: SdkServiceCallEnvelope[] = [];
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': SVC_PROVIDER_GRANTS, 'plugin-b': SVC_PROVIDER_GRANTS },
      serviceCallSink: (_pluginId, envelope) => {
        pushed.push(envelope);
        return true;
      },
    });
    const core = wired(host);
    await core.submit(
      svcCall('plugin-b', 'services.provide', {
        name: 'calc',
        version: '1.0.0',
        methods: ['double'],
      }),
    ).promise;
    const connect = core.submit(
      svcCall('plugin-a', 'services.connect', {
        name: 'calc',
        version: '1.0.0',
        method: 'double',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed).toHaveLength(1);
    host.revoke('plugin-b', 'services.provide');
    await expectCode(connect.promise, 'CAPABILITY_REVOKED');
    // Registration is gone too: the next connect misses.
    await expectCode(
      core.submit(
        svcCall('plugin-a', 'services.connect', {
          name: 'calc',
          version: '1.0.0',
          method: 'double',
        }),
      ).promise,
      'NOT_FOUND',
    );
  });

  it('expires pending calls on their deadline (§26.1.1)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': SVC_PROVIDER_GRANTS, 'plugin-b': SVC_PROVIDER_GRANTS },
      serviceCallSink: () => true,
    });
    const core = wired(host);
    await core.submit(
      svcCall('plugin-b', 'services.provide', {
        name: 'calc',
        version: '1.0.0',
        methods: ['double'],
      }),
    ).promise;
    const call = makeCall({
      method: 'services.connect',
      args: { name: 'calc', version: '1.0.0', method: 'double', deadlineMs: 40 },
      capability: { name: 'services.connect' },
      deadlineAt: Date.now() + 40,
    });
    await expectCode(core.submit(call).promise, 'OPERATION_DEADLINE');
  });

  it('requires services grants', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': [] } });
    const core = wired(host);
    await expectCode(
      core.submit(
        svcCall('plugin-a', 'services.provide', {
          name: 'calc',
          version: '1.0.0',
          methods: ['double'],
        }),
      ).promise,
      'CAPABILITY_DENIED',
    );
    await expectCode(
      core.submit(
        svcCall('plugin-a', 'services.connect', {
          name: 'calc',
          version: '1.0.0',
          method: 'double',
        }),
      ).promise,
      'CAPABILITY_DENIED',
    );
  });
});

// ---- §33 Secrets API (Stage E) ----

const SECRETS_GRANTS = ['secrets.use', 'secrets.manageOwn', 'secrets.reveal'];

function stubSecretsProvider(): SecretsProvider {
  return {
    async use(pluginId, connectionId) {
      return {
        serviceId: 'com.example.api',
        origin: 'https://api.example.com',
        headers: { Authorization: `Bearer token-${pluginId}-${connectionId}` },
        expiresAt: null,
      };
    },
    async manageOwn(pluginId) {
      return [
        {
          connectionId: 'conn-1',
          serviceId: 'com.example.api',
          serviceName: 'Example API',
          scopes: ['read'],
          status: 'connected',
        },
        {
          connectionId: 'conn-2',
          serviceId: 'other',
          serviceName: 'Other',
          scopes: [],
          status: 'pending',
        },
      ].filter((entry) => entry.serviceId === 'com.example.api' && pluginId === 'plugin-a');
    },
    async reveal(pluginId, connectionId) {
      return {
        accessToken: `raw-${pluginId}-${connectionId}`,
        tokenType: 'Bearer',
        expiresAt: null,
      };
    },
  };
}

function secretsCall(method: string, args: Record<string, unknown>): BrokerCallRequest {
  svcSeq += 1;
  return makeCall({
    requestId: `req-sec-${svcSeq}`,
    method,
    args,
    capability: { name: METHOD_CAPABILITY[method] ?? 'secrets.use' },
  });
}

function fetchWithSecret(url: string, secretId: string): BrokerCallRequest {
  svcSeq += 1;
  return makeCall({
    requestId: `req-sec-f-${svcSeq}`,
    method: 'network.http.fetch',
    args: { url, secretId },
    capability: { name: 'network.http' },
  });
}

describe('secrets API (§33)', () => {
  it('mints a bound handle and injects the header on fetch (§29.1.5)', async () => {
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      seenHeaders.push(init?.headers as Record<string, string> | undefined);
      return mockResponse(200, 'ok');
    };
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': [...SECRETS_GRANTS, 'network.http'] },
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
      secretsProvider: stubSecretsProvider(),
    });
    const core = wired(host);
    const used = (await core.submit(secretsCall('secrets.use', { connectionId: 'conn-1' }))
      .promise) as { handle: string; serviceId: string };
    expect(used.handle).toMatch(/^sec-/);
    expect(used.serviceId).toBe('com.example.api');

    await core.submit(fetchWithSecret('https://api.example.com/v1', used.handle)).promise;
    expect(seenHeaders[0]).toEqual({ Authorization: 'Bearer token-plugin-a-conn-1' });

    // The handle is bound to its origin: another destination is refused.
    await expectCode(
      core.submit(fetchWithSecret('https://elsewhere.example/v1', used.handle)).promise,
      'NETWORK_SECRET_ORIGIN_MISMATCH',
    );
  });

  it('refuses handles minted for another plugin', async () => {
    const host = createMemoryHostExecutor({
      grants: {
        'plugin-a': [...SECRETS_GRANTS, 'network.http'],
        'plugin-b': [...SECRETS_GRANTS, 'network.http'],
      },
      fetchImpl: async () => mockResponse(200, 'ok'),
      dnsLookupImpl: async () => ['93.184.216.34'],
      secretsProvider: stubSecretsProvider(),
    });
    const core = wired(host);
    const used = (await core.submit(secretsCall('secrets.use', { connectionId: 'conn-1' }))
      .promise) as { handle: string };
    await expectCode(
      core.submit(
        makeCall({
          requestId: `req-sec-x-${++svcSeq}`,
          method: 'network.http.fetch',
          args: { url: 'https://api.example.com/v1', secretId: used.handle },
          caller: { pluginId: 'plugin-b', installationId: 'inst-b', trustLevel: 'sandbox' },
          capability: { name: 'network.http' },
        }),
      ).promise,
      'NETWORK_SECRET_NOT_FOUND',
    );
  });

  it('lists own connections and reveals only for trusted callers', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': SECRETS_GRANTS },
      secretsProvider: stubSecretsProvider(),
    });
    const core = wired(host);
    const listed = (await core.submit(secretsCall('secrets.manageOwn', {})).promise) as {
      connections: Array<{ connectionId: string }>;
    };
    expect(listed.connections).toEqual([
      expect.objectContaining({ connectionId: 'conn-1', status: 'connected' }),
    ]);

    // Sandboxed caller: TRUST_REQUIRED before the provider is consulted.
    await expectCode(
      core.submit(secretsCall('secrets.reveal', { connectionId: 'conn-1' })).promise,
      'TRUST_REQUIRED',
    );
    const trusted = await core.submit(
      makeCall({
        requestId: `req-sec-t-${++svcSeq}`,
        method: 'secrets.reveal',
        args: { connectionId: 'conn-1' },
        caller: { pluginId: 'plugin-a', installationId: 'inst-a', trustLevel: 'trusted' },
        capability: { name: 'secrets.reveal' },
      }),
    ).promise;
    expect(trusted).toEqual({
      accessToken: 'raw-plugin-a-conn-1',
      tokenType: 'Bearer',
      expiresAt: null,
    });
  });

  it('closes live handles on revoke and caps the registry (§10.2)', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'plugin-a': [...SECRETS_GRANTS, 'network.http'] },
      fetchImpl: async () => mockResponse(200, 'ok'),
      dnsLookupImpl: async () => ['93.184.216.34'],
      secretsProvider: stubSecretsProvider(),
    });
    const core = wired(host);
    const used = (await core.submit(secretsCall('secrets.use', { connectionId: 'conn-1' }))
      .promise) as { handle: string };
    host.revoke('plugin-a', 'secrets.use');
    await expectCode(
      core.submit(fetchWithSecret('https://api.example.com/v1', used.handle)).promise,
      'NETWORK_SECRET_NOT_FOUND',
    );

    // Cap: only SECRETS_MAX_LIVE handles per plugin.
    const capped = createMemoryHostExecutor({
      grants: { 'plugin-a': SECRETS_GRANTS },
      secretsProvider: stubSecretsProvider(),
    });
    const cappedCore = wired(capped);
    for (let i = 0; i < 16; i += 1) {
      await cappedCore.submit(secretsCall('secrets.use', { connectionId: 'conn-1' })).promise;
    }
    await expectCode(
      cappedCore.submit(secretsCall('secrets.use', { connectionId: 'conn-1' })).promise,
      'SERVICE_UNAVAILABLE',
    );
  });

  it('requires secrets grants and a configured provider', async () => {
    const host = createMemoryHostExecutor({ grants: { 'plugin-a': [] } });
    const core = wired(host);
    await expectCode(
      core.submit(secretsCall('secrets.use', { connectionId: 'conn-1' })).promise,
      'CAPABILITY_DENIED',
    );
    const noProvider = createMemoryHostExecutor({ grants: { 'plugin-a': SECRETS_GRANTS } });
    const noProviderCore = wired(noProvider);
    await expectCode(
      noProviderCore.submit(secretsCall('secrets.use', { connectionId: 'conn-1' })).promise,
      'SERVICE_UNAVAILABLE',
    );
  });
});
