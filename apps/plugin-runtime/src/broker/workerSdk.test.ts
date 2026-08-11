/**
 * Worker Core SDK end-to-end tests (Stage D, ТЗ §12 Application/Storage).
 *
 * The same real-worker harness as the broker tests, but the plugin module
 * drives the typed `sdk` endowment (kv + settings) instead of raw `bridge`.
 * Pins: operation round-trips, chained calls settling before the snapshot is
 * taken, capability names on the wire matching the §12 catalog, per-capability
 * denial (settings.write without grant), and worker-side input validation
 * that never reaches the wire.
 */
import { describe, expect, it } from 'vitest';
import type { BrokerCallRequest, SdkServiceCallEnvelope } from '@neotavern/contracts';
import { createServer, type Server } from 'node:net';
import { RPC_STREAM_CHUNK_BYTES, SdkOperationMethod, encodeDataBody } from '@neotavern/contracts';
import {
  createMemoryHostExecutor,
  type MemoryHostExecutor,
  type SecretsProvider,
} from '../host/memoryHost.js';
import { withBrokerWorker, type ModuleGraphLoaded } from './workerTestUtil.js';

function hostWithGrants(grants: string[]): MemoryHostExecutor {
  return createMemoryHostExecutor({ grants: { 'test.broker': grants } });
}

function receivedCalls(received: BrokerCallRequest[], method: string): BrokerCallRequest[] {
  return received.filter((call) => call.method === method);
}

describe('worker core sdk (kv + settings)', () => {
  it('round-trips KV values through the typed sdk, chained calls included', async () => {
    const received: BrokerCallRequest[] = [];
    const host = hostWithGrants(['storage.kv']);
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.kv.set('greeting', { text: 'hello' })",
          "  .then(() => sdk.kv.get('greeting'))",
          '  .then((value) => { result = value; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot).toEqual({ result: { value: { text: 'hello' } } });

        const methods = received.map((call) => call.method);
        expect(methods).toEqual([SdkOperationMethod.KV_SET, SdkOperationMethod.KV_GET]);
        for (const call of received) {
          expect(call.capability.name).toBe('storage.kv');
          expect(call.caller.pluginId).toBe('test.broker');
        }
        expect(receivedCalls(received, SdkOperationMethod.KV_SET)[0]?.args).toEqual({
          key: 'greeting',
          value: { text: 'hello' },
        });
        expect(host.kvSnapshot('test.broker')).toEqual({ greeting: { text: 'hello' } });
      },
    );
  });

  it('round-trips settings through the typed sdk', async () => {
    const host = hostWithGrants(['settings.read', 'settings.write']);
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.settings.set('general.temperature', 0.9)",
          "  .then(() => sdk.settings.get('general.temperature'))",
          '  .then((value) => { result = value; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot).toEqual({ result: { value: 0.9 } });
        expect(host.settingsSnapshot('test.broker')).toEqual({ 'general.temperature': 0.9 });
      },
    );
  });

  it('denies settings.write without the grant and never executes the operation', async () => {
    const host = hostWithGrants(['storage.kv']);
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.settings.set('secret', 1)",
          '  .then(undefined, (err) => { error = { code: err.code, message: err.message }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const error = message.snapshot['error'] as { code?: string; message?: string };
        expect(error.code).toBe('CAPABILITY_DENIED');
        expect(host.settingsSnapshot('test.broker')).toEqual({});
      },
    );
  });

  it('validates sdk inputs in the worker and never sends a malformed call', async () => {
    const received: BrokerCallRequest[] = [];
    const host = hostWithGrants(['storage.kv']);
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          'export let error;',
          "sdk.kv.get('').then((value) => { result = value; },",
          '  (err) => { error = { code: err.code, message: err.message }; });',
          'sdk.kv.list().then((value) => { result = value; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const error = message.snapshot['error'] as { code?: string; message?: string };
        expect(error.code).toBe('VALIDATION_FAILED');
        // Only the valid list() call reached the wire; the empty-key call was
        // rejected locally in the bootstrap.
        expect(received.map((call) => call.method)).toEqual([SdkOperationMethod.KV_LIST]);
        expect(message.snapshot['result']).toEqual({ keys: [] });
      },
    );
  });

  it('reports VALIDATION_FAILED for values that exceed the sdk size bound', async () => {
    const host = hostWithGrants(['storage.kv']);
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "const big = 'x'.repeat(9 * 1024 * 1024);",
          "sdk.kv.set('big', big)",
          '  .then(undefined, (err) => { error = { code: err.code, message: err.message }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const error = message.snapshot['error'] as { code?: string; message?: string };
        expect(error.code).toBe('VALIDATION_FAILED');
        expect(host.kvSnapshot('test.broker')).toEqual({});
      },
    );
  });

  it('round-trips a KV value above the old 32 KiB control cap (Stage F part 13)', async () => {
    const host = hostWithGrants(['storage.kv']);
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "const big = 'y'.repeat(100 * 1024);",
          "sdk.kv.set('big', big).then(() => sdk.kv.get('big'))",
          '  .then((res) => { result = { len: res.value.length, head: res.value.slice(0, 3) }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toEqual({ len: 100 * 1024, head: 'yyy' });
        const stored = host.kvSnapshot('test.broker')['big'];
        expect(typeof stored).toBe('string');
        expect((stored as string).length).toBe(100 * 1024);
      },
    );
  });

  it('round-trips a settings value above the old 32 KiB control cap (Stage F part 13)', async () => {
    const host = hostWithGrants(['settings.read', 'settings.write']);
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "const big = 'z'.repeat(100 * 1024);",
          "sdk.settings.set('my.big', big).then(() => sdk.settings.get('my.big'))",
          '  .then((res) => { result = { len: res.value.length, head: res.value.slice(0, 3) }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toEqual({ len: 100 * 1024, head: 'zzz' });
      },
    );
  });
});

describe('worker core sdk (events channel, §18)', () => {
  it('replays host-emitted events from the beginning of the buffer', async () => {
    const host = hostWithGrants(['storage.kv']);
    host.emit('chat.message.created', { id: 1 });
    host.emit('chat.message.created', { id: 2 });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.events.replay({ name: 'chat.message.created' })",
          '  .then((value) => { result = value; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const result = message.snapshot['result'] as {
          events: { seq: number; payload: unknown }[];
          nextCursor: number;
        };
        expect(result.events).toHaveLength(2);
        expect(result.events[0]!.seq).toBe(1);
        expect(result.events[0]!.payload).toEqual({ id: 1 });
        expect(result.events[1]!.seq).toBe(2);
        expect(result.nextCursor).toBe(2);
      },
    );
  });

  it('waits for an event emitted after the replay call starts', async () => {
    const host = hostWithGrants(['storage.kv']);
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.events.replay({ name: 'live.tick', waitMs: 2000 })",
          '  .then((value) => { result = value; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        // Emit shortly after the load starts so the in-flight waiter wakes;
        // even if it lands before the worker reaches the replay call, the
        // buffer already holds the event and replay returns immediately.
        setTimeout(() => host.emit('live.tick', 'hello'), 50);
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const result = message.snapshot['result'] as {
          events: { seq: number; payload: unknown }[];
          nextCursor: number;
        };
        expect(result.events).toHaveLength(1);
        expect(result.events[0]!.payload).toBe('hello');
        expect(result.nextCursor).toBe(1);
      },
    );
  });

  it('expires a cursor that fell outside the replay window', async () => {
    const host = hostWithGrants(['storage.kv']);
    for (let i = 1; i <= 130; i += 1) host.emit('metrics', i);
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.events.replay({ name: 'metrics', cursor: 1 })",
          '  .then(undefined, (err) => { error = { code: err.code, message: err.message }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const error = message.snapshot['error'] as { code?: string; message?: string };
        expect(error.code).toBe('EVENT_CURSOR_EXPIRED');
      },
    );
  });
});

describe('worker core sdk (events live delivery, §18 Stage F)', () => {
  /** Poll the host KV store until the key appears or the deadline passes. */
  async function waitForKv(
    host: MemoryHostExecutor,
    key: string,
    deadlineMs = 3000,
  ): Promise<unknown> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const snapshot = host.kvSnapshot('test.broker');
      if (key in snapshot) return snapshot[key];
      if (Date.now() >= deadline) throw new Error(`kv key '${key}' never arrived`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('delivers host-emitted events to the worker iterator in real time', async () => {
    let controlPort: { postMessage(message: unknown): void } | undefined;
    const sinkHost = createMemoryHostExecutor({
      grants: { 'test.broker': ['storage.kv'] },
      eventPushSink: (subscriptionId, envelope) => {
        if (controlPort === undefined) return false;
        controlPort.postMessage({ kind: 'event-push', subscriptionId, envelope });
        return true;
      },
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.events.subscribe({ name: 'live.tick' }).then((handle) => {",
          '  handle.next().then((first) => {',
          "    sdk.kv.set('first', first.value).then(() => {",
          '      handle.next().then((second) => {',
          "        sdk.kv.set('second', second.value).then(() => {",
          '          handle.close();',
          '          result = "closed";',
          '        });',
          '      });',
          '    });',
          '  });',
          '});',
        ].join('\n'),
      },
      sinkHost.policy,
      {},
      async ({ load, record }) => {
        controlPort = record.control;
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(sinkHost.eventSubscriptionCount()).toBe(1);

        // Push 1: emitted after load; the iterator resolves and the worker
        // round-trips the envelope back into host KV via a real broker call.
        sinkHost.emit('live.tick', { n: 1 });
        await expect(waitForKv(sinkHost, 'first')).resolves.toMatchObject({
          seq: 1,
          name: 'live.tick',
          payload: { n: 1 },
        });
        sinkHost.emit('live.tick', { n: 2 });
        await expect(waitForKv(sinkHost, 'second')).resolves.toMatchObject({
          seq: 2,
          payload: { n: 2 },
        });

        // The plugin closed the iterator: further pushes are ignored and the
        // host-side subscription is dropped on close (worker called
        // events.unsubscribe).
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(sinkHost.eventSubscriptionCount()).toBe(0);
        sinkHost.emit('live.tick', { n: 3 });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(Object.keys(sinkHost.kvSnapshot('test.broker'))).toEqual(['first', 'second']);
      },
    );
  });

  it('validates subscribe inputs in the worker and never sends a malformed call', async () => {
    const received: BrokerCallRequest[] = [];
    const sinkHost = createMemoryHostExecutor({
      grants: { 'test.broker': ['storage.kv'] },
      eventPushSink: () => true,
    });
    const executor = sinkHost.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.events.subscribe({ name: '' }).then(undefined,",
          '  (err) => { error = { code: err.code, message: err.message }; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const error = message.snapshot['error'] as { code?: string; message?: string };
        expect(error.code).toBe('VALIDATION_FAILED');
        // Rejected locally in the bootstrap; nothing reached the wire.
        expect(received).toEqual([]);
      },
    );
  });

  it('reassembles a §17 credit-streamed response (Stage F part 14)', async () => {
    let capturedRequestId: string | undefined;
    const policy = {
      // The broker admits the call but never answers: the test itself
      // streams the reply so the worker-side accumulator path is exercised.
      authorize: (call: BrokerCallRequest) => {
        capturedRequestId = call.requestId;
        return { allowed: true } as const;
      },
      execute: () => new Promise(() => {}),
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.kv.get('big')",
          '  .then((value) => {',
          '    result = { textLength: value.value.text.length, head: value.value.text.slice(0, 3) };',
          '  });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ record, load }) => {
        const loadedPromise = load();
        const deadline = Date.now() + 5000;
        while (capturedRequestId === undefined) {
          if (Date.now() > deadline) throw new Error('pending call never reached the broker');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const requestId = capturedRequestId as string;
        // Encode the response body once (§15.1), then stream it in §17 chunks.
        const bodyBytes = encodeDataBody({
          workerId: 21,
          workerEpoch: 0,
          requestId,
          ok: true,
          result: { value: { text: 'z'.repeat(600 * 1024) } },
        });
        const encoder = new TextEncoder();
        let offset = 0;
        let seq = 0;
        while (offset < bodyBytes.byteLength) {
          const end = Math.min(offset + RPC_STREAM_CHUNK_BYTES, bodyBytes.byteLength);
          const chunk = bodyBytes.subarray(offset, end);
          const final = end === bodyBytes.byteLength;
          const header = encoder.encode(JSON.stringify({ requestId, seq, final }));
          const payload = new Uint8Array(header.byteLength + 1 + chunk.byteLength);
          payload.set(header, 0);
          payload.set(chunk, header.byteLength + 1);
          record.control.postMessage({ kind: 'rpc-response-stream', payloadBytes: payload });
          offset = end;
          seq += 1;
        }
        const message = (await loadedPromise) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot).toEqual({
          result: { textLength: 600 * 1024, head: 'zzz' },
        });
      },
    );
  });
});

describe('worker core sdk (network fetch, §29)', () => {
  function hostWithOptions(
    grants: string[],
    options: { fetchImpl?: typeof fetch; dnsLookupImpl?: (h: string) => Promise<string[]> } = {},
  ): MemoryHostExecutor {
    return createMemoryHostExecutor({
      grants: { 'test.broker': grants },
      fetchImpl: options.fetchImpl,
      dnsLookupImpl: options.dnsLookupImpl,
    });
  }

  function mockResponse(
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): Response {
    return {
      status,
      statusText: '',
      headers: new Headers(headers),
      text: () => Promise.resolve(body),
    } as unknown as Response;
  }

  it('round-trips a public fetch through the typed sdk', async () => {
    const fetchImpl = async () => mockResponse(200, 'hello', { 'x-test': '1' });
    const host = hostWithOptions(['network.http'], {
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.network.fetch('https://example.com')",
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          status: 200,
          body: 'hello',
          url: 'https://example.com',
          redirects: [],
        });
      },
    );
  });

  it('returns fetch bodies above the old 32 KiB control cap intact (Stage F)', async () => {
    // The executor must not truncate the body anymore: the response travels
    // the data pipe (RPC_RESPONSE_DATA) in the subprocess path; here the
    // in-process worker proves the executor delivers the full body.
    const body = 'z'.repeat(100 * 1024);
    const fetchImpl = async () => mockResponse(200, body);
    const host = hostWithOptions(['network.http'], {
      fetchImpl,
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.network.fetch('https://example.com/big')",
          '  .then((r) => { result = { bodyLength: r.body.length, head: r.body.slice(0, 3) }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toEqual({
          bodyLength: 100 * 1024,
          head: 'zzz',
        });
      },
    );
  });

  it('denies loopback destinations with NETWORK_DESTINATION_DENIED', async () => {
    const host = hostWithOptions(['network.http'], {
      fetchImpl: async () => mockResponse(200, 'should-not-reach'),
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.network.fetch('http://127.0.0.1/admin')",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe(
          'NETWORK_DESTINATION_DENIED',
        );
      },
    );
  });

  it('requires the network.http grant', async () => {
    const host = hostWithOptions([], {
      fetchImpl: async () => mockResponse(200, 'ok'),
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.network.fetch('https://example.com')",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });

  it('passes an opaque secretId through to the host executor (§29.1.5)', async () => {
    const received: BrokerCallRequest[] = [];
    const host = createMemoryHostExecutor({
      grants: { 'test.broker': ['network.http'] },
      fetchImpl: async () => mockResponse(200, 'ok'),
      dnsLookupImpl: async () => ['93.184.216.34'],
      networkSecrets: {
        'api-token': {
          origin: 'https://example.com',
          headers: { authorization: 'Bearer sekrit' },
        },
      },
    });
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.network.fetch('https://example.com', { secretId: 'api-token' })",
          '  .then((r) => { result = { status: r.status }; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toEqual({ status: 200 });
        expect(received).toHaveLength(1);
        expect(received[0]?.args).toMatchObject({
          url: 'https://example.com',
          secretId: 'api-token',
        });
      },
    );
  });

  it('rejects an oversized secretId locally before the wire', async () => {
    const received: BrokerCallRequest[] = [];
    const host = createMemoryHostExecutor({
      grants: { 'test.broker': ['network.http'] },
      fetchImpl: async () => mockResponse(200, 'ok'),
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    const longId = `x${'a'.repeat(200)}`;
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          `sdk.network.fetch('https://example.com', { secretId: '${longId}' })`,
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('VALIDATION_FAILED');
        // Rejected in the bootstrap; nothing reached the broker.
        expect(received).toEqual([]);
      },
    );
  });
});

describe('worker core sdk (models.list, §12 Models)', () => {
  function hostWithModels(
    grants: string[],
    modelsProvider: (
      id: string,
    ) => Promise<{ id: string; name: string; contextLimit?: number }[] | null>,
  ): MemoryHostExecutor {
    return createMemoryHostExecutor({
      grants: { 'test.broker': grants },
      modelsProvider,
    });
  }

  it('round-trips models.list through the typed sdk', async () => {
    const host = hostWithModels(['models.list'], async (id) =>
      id === 'prov-a'
        ? [
            { id: 'gpt-4', name: 'GPT-4', contextLimit: 8192 },
            { id: 'gpt-3.5', name: 'GPT-3.5 Turbo' },
          ]
        : null,
    );
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.models.list('prov-a')",
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          models: [
            { id: 'gpt-4', name: 'GPT-4', contextLimit: 8192 },
            { id: 'gpt-3.5', name: 'GPT-3.5 Turbo' },
          ],
        });
      },
    );
  });

  it('surfaces NOT_FOUND for an unknown provider', async () => {
    const host = hostWithModels(['models.list'], async () => null);
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.models.list('prov-missing')",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('NOT_FOUND');
      },
    );
  });

  it('requires the models.list grant', async () => {
    const host = hostWithModels([], async () => [{ id: 'x', name: 'X' }]);
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.models.list('prov-a')",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });
});

describe('worker core sdk (chats, §12 Application)', () => {
  function hostWithChats(
    grants: string[],
    options: {
      chatsList?: (q: { cursor?: string; limit?: number; characterId?: string }) => Promise<{
        items: {
          id: string;
          characterId: string | null;
          title: string;
          messageCount: number;
          createdAt: number;
          updatedAt: number;
          origin: 'checkpoint' | 'branch' | null;
          parentChatId: string | null;
          sourceMessageId: string | null;
        }[];
        nextCursor: string | null;
      }>;
      chatsRead?: (chatId: string) => Promise<{
        id: string;
        characterId: string | null;
        personaId: string | null;
        title: string;
        activeBranchId: string | null;
        backgroundId: string | null;
        summary: string;
        messageCount: number;
        createdAt: number;
        updatedAt: number;
        deletedAt: number | null;
        origin: 'checkpoint' | 'branch' | null;
        parentChatId: string | null;
        sourceMessageId: string | null;
      } | null>;
    } = {},
  ): MemoryHostExecutor {
    return createMemoryHostExecutor({
      grants: { 'test.broker': grants },
      chatsList: options.chatsList,
      chatsRead: options.chatsRead,
    });
  }

  it('round-trips chats.list through the typed sdk', async () => {
    const host = hostWithChats(['chats.read'], {
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
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          'sdk.chats.list({ limit: 10 })',
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          items: [{ id: 'chat-1', title: 'Hello' }],
          nextCursor: 'next-page',
        });
      },
    );
  });

  it('round-trips chats.read through the typed sdk', async () => {
    const host = hostWithChats(['chats.read'], {
      chatsRead: async (id) =>
        id === 'chat-1'
          ? {
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
            }
          : null,
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.chats.read('chat-1')",
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          chat: { id: 'chat-1', title: 'Hello', messageCount: 3 },
        });
      },
    );
  });

  it('surfaces NOT_FOUND for a missing chat', async () => {
    const host = hostWithChats(['chats.read'], {
      chatsRead: async () => null,
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.chats.read('chat-missing')",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('NOT_FOUND');
      },
    );
  });

  it('requires the chats.read grant', async () => {
    const host = hostWithChats([], {
      chatsList: async () => ({ items: [], nextCursor: null }),
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          'sdk.chats.list()',
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });
});

describe('worker core sdk (characters, §12 Application)', () => {
  function hostWithCharacters(
    grants: string[],
    options: {
      charactersList?: (q: { cursor?: string; limit?: number }) => Promise<{
        items: {
          id: string;
          name: string;
          avatar: string | null;
          description: string;
          tags: string[];
          createdAt: number;
          updatedAt: number;
        }[];
        nextCursor: string | null;
      }>;
      charactersRead?: (characterId: string) => Promise<{
        id: string;
        name: string;
        avatar: string | null;
        description: string;
        personality: string;
        scenario: string;
        firstMessage: string;
        exampleDialogues: string;
        systemPrompt: string | null;
        postHistoryInstructions: string | null;
        creator: string | null;
        creatorNotes: string | null;
        tags: string[];
        ext: Record<string, unknown>;
        createdAt: number;
        updatedAt: number;
        lastUsedAt: number | null;
        deletedAt: number | null;
      } | null>;
    } = {},
  ): MemoryHostExecutor {
    return createMemoryHostExecutor({
      grants: { 'test.broker': grants },
      charactersList: options.charactersList,
      charactersRead: options.charactersRead,
    });
  }

  it('round-trips characters.list through the typed sdk', async () => {
    const host = hostWithCharacters(['characters.read'], {
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
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          'sdk.characters.list({ limit: 10 })',
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          items: [{ id: 'char-1', name: 'Alice' }],
          nextCursor: 'next-page',
        });
      },
    );
  });

  it('round-trips characters.read through the typed sdk', async () => {
    const host = hostWithCharacters(['characters.read'], {
      charactersRead: async (id) =>
        id === 'char-1'
          ? {
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
              tags: [],
              ext: {},
              createdAt: 1000,
              updatedAt: 2000,
              lastUsedAt: null,
              deletedAt: null,
            }
          : null,
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.characters.read('char-1')",
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          character: { id: 'char-1', name: 'Alice', firstMessage: 'Hello' },
        });
      },
    );
  });

  it('surfaces NOT_FOUND for a missing character', async () => {
    const host = hostWithCharacters(['characters.read'], {
      charactersRead: async () => null,
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.characters.read('char-missing')",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('NOT_FOUND');
      },
    );
  });

  it('requires the characters.read grant', async () => {
    const host = hostWithCharacters([], {
      charactersList: async () => ({ items: [], nextCursor: null }),
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          'sdk.characters.list()',
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });
});

describe('worker core sdk (lorebook, §12 Application)', () => {
  function hostWithLorebook(
    grants: string[],
    options: {
      lorebooksList?: (q: { cursor?: string; limit?: number; characterId?: string }) => Promise<{
        items: {
          id: string;
          name: string;
          description: string;
          characterId: string | null;
          metadata: Record<string, unknown>;
          createdAt: number;
          updatedAt: number;
        }[];
        nextCursor: string | null;
      }>;
      lorebookRead?: (bookId: string) => Promise<{
        id: string;
        name: string;
        description: string;
        characterId: string | null;
        metadata: Record<string, unknown>;
        createdAt: number;
        updatedAt: number;
      } | null>;
      lorebookEntries?: (bookId: string) => Promise<
        | {
            id: string;
            lorebookId: string;
            keys: string[];
            secondaryKeys: string[];
            content: string;
            enabled: boolean;
            position: number;
            constant: boolean;
            selective: boolean;
            metadata: Record<string, unknown>;
            createdAt: number;
            updatedAt: number;
          }[]
        | null
      >;
    } = {},
  ): MemoryHostExecutor {
    return createMemoryHostExecutor({
      grants: { 'test.broker': grants },
      lorebooksList: options.lorebooksList,
      lorebookRead: options.lorebookRead,
      lorebookEntries: options.lorebookEntries,
    });
  }

  it('round-trips lorebook.list through the typed sdk', async () => {
    const host = hostWithLorebook(['lorebook.read'], {
      lorebooksList: async () => ({
        items: [
          {
            id: 'book-1',
            name: 'World',
            description: 'A lorebook',
            characterId: null,
            metadata: {},
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
        nextCursor: 'next-page',
      }),
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          'sdk.lorebook.list({ limit: 10 })',
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          items: [{ id: 'book-1', name: 'World' }],
          nextCursor: 'next-page',
        });
      },
    );
  });

  it('round-trips lorebook.read through the typed sdk', async () => {
    const host = hostWithLorebook(['lorebook.read'], {
      lorebookRead: async (id) =>
        id === 'book-1'
          ? {
              id: 'book-1',
              name: 'World',
              description: 'A lorebook',
              characterId: null,
              metadata: {},
              createdAt: 1000,
              updatedAt: 2000,
            }
          : null,
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.lorebook.read('book-1')",
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          book: { id: 'book-1', name: 'World' },
        });
      },
    );
  });

  it('round-trips lorebook.entries through the typed sdk', async () => {
    const host = hostWithLorebook(['lorebook.read'], {
      lorebookEntries: async (id) =>
        id === 'book-1'
          ? [
              {
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
              },
            ]
          : null,
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.lorebook.entries('book-1')",
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          items: [{ id: 'entry-1', content: 'The castle is old.' }],
        });
      },
    );
  });

  it('surfaces NOT_FOUND for a missing lorebook', async () => {
    const host = hostWithLorebook(['lorebook.read'], {
      lorebookRead: async () => null,
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.lorebook.read('book-missing')",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('NOT_FOUND');
      },
    );
  });

  it('requires the lorebook.read grant', async () => {
    const host = hostWithLorebook([], {
      lorebooksList: async () => ({ items: [], nextCursor: null }),
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          'sdk.lorebook.list()',
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });
});

describe('worker core sdk (database.core.query, §31)', () => {
  function hostWithDb(
    grants: string[],
    dbQuery?: (q: { sql: string; params: unknown[] }) => Promise<{
      columns: string[];
      rows: unknown[][];
    }>,
  ): MemoryHostExecutor {
    return createMemoryHostExecutor({
      grants: { 'test.broker': grants },
      dbQuery,
    });
  }

  it('round-trips a read query through the typed sdk', async () => {
    const host = hostWithDb(['database.core.read'], async ({ params }) => ({
      columns: ['id', 'name'],
      rows: [[1, 'Alice'], ...params.map((p) => [2, p])],
    }));
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.db.query('SELECT id, name FROM characters WHERE id = ?', ['char-1'])",
          '  .then((r) => { result = r; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['result']).toMatchObject({
          columns: ['id', 'name'],
          rows: [
            [1, 'Alice'],
            [2, 'char-1'],
          ],
        });
      },
    );
  });

  it('rejects invalid sql and params locally before the wire', async () => {
    const host = hostWithDb(['database.core.read'], async () => ({
      columns: [],
      rows: [],
    }));
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let errors = [];',
          "sdk.db.query('')",
          '  .then(undefined, (err) => { errors.push(err.code); });',
          "sdk.db.query('SELECT ?', [{ nested: 1 }])",
          '  .then(undefined, (err) => { errors.push(err.code); });',
          "sdk.db.query('SELECT ?', [Infinity])",
          '  .then(undefined, (err) => { errors.push(err.code); });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['errors']).toEqual([
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
        ]);
      },
    );
  });

  it('requires the database.core.read grant', async () => {
    const host = hostWithDb([], async () => ({ columns: [], rows: [] }));
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.db.query('SELECT 1')",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });
});

describe('worker core sdk (network sockets, §29 Stage E)', () => {
  /** Ephemeral loopback echo server. */
  async function echoServer(): Promise<{
    port: number;
    close: () => Promise<void>;
  }> {
    const server: Server = createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return {
      port: address.port,
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    };
  }

  it('round-trips a tcp echo through the typed sdk', async () => {
    const { port, close } = await echoServer();
    try {
      const host = createMemoryHostExecutor({
        grants: { 'test.broker': ['network.tcp', 'network.local'] },
      });
      await withBrokerWorker(
        {
          'src/index.js': [
            'export let result;',
            `sdk.network.tcp.connect('127.0.0.1', ${port})`,
            "  .then((handle) => sdk.network.tcp.send(handle.id, 'ping').then(() => handle))",
            '  .then((handle) => sdk.network.tcp.receive(handle.id, { waitMs: 2000 }).then((out) => ({ handle, out })))',
            '  .then(({ handle, out }) => sdk.network.tcp.close(handle.id).then(() => out))',
            '  .then((out) => { result = out; });',
          ].join('\n'),
        },
        host.policy,
        {},
        async ({ load }) => {
          const message = (await load()) as ModuleGraphLoaded;
          expect(message.kind).toBe('module-graph-loaded');
          expect(message.snapshot).toEqual({
            result: { messages: ['ping'], closed: false },
          });
        },
      );
    } finally {
      await close();
    }
  });

  it('denies network.tcp without the grant', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': [] } });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.network.tcp.connect('127.0.0.1', 1234)",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });

  it('validates socket inputs in the worker before they reach the wire', async () => {
    const received: BrokerCallRequest[] = [];
    const host = createMemoryHostExecutor({ grants: { 'test.broker': ['network.tcp'] } });
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let errors;',
          "const bad = [() => sdk.network.tcp.connect('', 80), () => sdk.network.tcp.connect('x', 70000), () => sdk.network.tcp.send(123, 'x'), () => sdk.network.tcp.receive(123)];",
          'Promise.all(bad.map((fn) => fn().then(undefined, (e) => e.code)))',
          '  .then((codes) => { errors = codes; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['errors']).toEqual([
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
        ]);
        expect(received).toHaveLength(0);
      },
    );
  });
});

describe('worker core sdk (files, §30 Stage E)', () => {
  it('round-trips files through the typed sdk inside the plugin root', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': ['files.plugin'] } });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.files.write('notes/a.txt', 'hello')",
          "  .then(() => sdk.files.read('notes/a.txt'))",
          "  .then((value) => sdk.files.stat('notes/a.txt').then((stat) => ({ value, stat })))",
          '  .then((out) => { result = out; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot).toEqual({
          result: { value: { content: 'hello' }, stat: { kind: 'file', size: 5 } },
        });
      },
    );
  });

  it('denies files.write without the grant and never executes it', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': [] } });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.files.write('a.txt', 'x')",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });

  it('rejects unsafe paths in the worker before they reach the wire', async () => {
    const received: BrokerCallRequest[] = [];
    const host = createMemoryHostExecutor({ grants: { 'test.broker': ['files.plugin'] } });
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let errors;',
          "const paths = ['../escape.txt', '/etc/passwd', 'a/../b.txt', 'a\\\\b.txt'];",
          'Promise.all(paths.map((p) => sdk.files.read(p).then(undefined, (e) => e.code)))',
          '  .then((codes) => { errors = codes; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['errors']).toEqual([
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
        ]);
        expect(received).toHaveLength(0);
      },
    );
  });
});

describe('worker core sdk (process, §13/§32 Stage E)', () => {
  it('spawns a scoped node process through the typed sdk and captures output', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': ['process.spawn'] } });
    const executable = process.execPath.replace(/\\/g, '/');
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          `sdk.process.spawn({ executable: ${JSON.stringify(executable)}, args: ['-e', 'console.log(\\'proc-ok\\')'] })`,
          '  .then((handle) => { const id = handle.id; return sdk.process.output(id, { waitMs: 3000 }).then((out) => sdk.process.wait(id, { waitMs: 3000 }).then((waited) => ({ out, waited }))); })',
          '  .then(({ out, waited }) => { result = { stdout: out.stdout, exitCode: waited.exitCode }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot).toEqual({
          result: { stdout: ['proc-ok\n'], exitCode: 0 },
        });
      },
    );
  });

  it('refuses process.spawn without the grant', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': [] } });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.process.spawn({ executable: '/nope' })",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });

  it('validates spawn inputs in the worker before they reach the wire', async () => {
    const received: BrokerCallRequest[] = [];
    const host = createMemoryHostExecutor({ grants: { 'test.broker': ['process.spawn'] } });
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let errors;',
          "const bad = [() => sdk.process.spawn({ executable: 'node' }), () => sdk.process.spawn({ executable: '/x', args: [123] }), () => sdk.process.spawn({ executable: '/x', env: { A: 1 } }), () => sdk.process.spawn({ executable: '/x', timeoutMs: -1 })];",
          'Promise.all(bad.map((fn) => fn().then(undefined, (e) => e.code)))',
          '  .then((codes) => { errors = codes; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['errors']).toEqual([
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
        ]);
        expect(received).toHaveLength(0);
      },
    );
  });
});

describe('worker core sdk (jobs, §19/§27 Stage E)', () => {
  it('registers and lists a job through the typed sdk', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': ['jobs.background'] } });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.jobs.register({ name: 'sync', intervalMs: 60000, payload: { n: 1 } })",
          '  .then((handle) => sdk.jobs.list().then((listed) => ({ handle, listed })))',
          '  .then(({ handle, listed }) => { result = { jobId: handle.jobId, names: listed.jobs.map((j) => j.name) }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const result = message.snapshot['result'] as { jobId: string; names: string[] };
        expect(result.jobId).toMatch(/^job-/);
        expect(result.names).toEqual(['sync']);
      },
    );
  });

  it('refuses jobs.register without the grant', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': [] } });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let error;',
          "sdk.jobs.register({ name: 'x', intervalMs: 60000 })",
          '  .then(undefined, (err) => { error = { code: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect((message.snapshot['error'] as { code: string }).code).toBe('CAPABILITY_DENIED');
      },
    );
  });

  it('validates job inputs in the worker before they reach the wire', async () => {
    const received: BrokerCallRequest[] = [];
    const host = createMemoryHostExecutor({ grants: { 'test.broker': ['jobs.background'] } });
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let errors;',
          "const bad = [() => sdk.jobs.register({ name: '' }), () => sdk.jobs.register({ name: 'x', intervalMs: 10 }), () => sdk.jobs.register({ name: 'x', intervalMs: 1000, atMs: 1000 }), () => sdk.jobs.cancel(123)];",
          'Promise.all(bad.map((fn) => fn().then(undefined, (e) => e.code)))',
          '  .then((codes) => { errors = codes; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['errors']).toEqual([
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
        ]);
        expect(received).toHaveLength(0);
      },
    );
  });
});

describe('worker core sdk (services, §34 Stage E)', () => {
  it('provides a service and pushes a connect with the received chain', async () => {
    const pushed: SdkServiceCallEnvelope[] = [];
    const host = createMemoryHostExecutor({
      grants: { 'test.broker': ['services.provide', 'services.connect'] },
      serviceCallSink: (_pluginId, envelope) => {
        pushed.push(envelope);
        return true;
      },
    });
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) =>
        executor.execute(call, signal),
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.services.provide({ name: 'calc', version: '1.0.0', methods: ['double'] }, (method, args) => {",
          '  return Promise.resolve({ value: (args?.n ?? 0) * 2 });',
          '})',
          '  .then((handle) => {',
          '    result = { provided: handle.serviceId };',
          "    return sdk.services.connect({ name: 'calc', version: '1.0.0', method: 'double', args: { n: 2 }, deadlineMs: 200 })",
          '      .then((r) => { result.loopback = r.result; })',
          '      .catch((err) => { result.connectError = err.code; });',
          '  })',
          '  .catch((err) => { result = { error: err.code }; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const result = message.snapshot['result'] as {
          provided: string;
          connectError?: string;
        };
        expect(result.provided).toMatch(/^svc-/);
        // The e2e harness has no bridge, so the pushed call is never
        // answered: the pending connect expires on its explicit deadline
        // instead of leaking.
        expect(result.connectError).toBe('OPERATION_DEADLINE');
        expect(pushed).toHaveLength(1);
        expect(pushed[0]).toMatchObject({
          method: 'double',
          args: { n: 2 },
          // The worker forwarded the received chain ([]) and the host
          // appended the caller id before pushing to the provider.
          chain: ['test.broker'],
        });
      },
    );
  });

  it('refuses services.provide and services.connect without grants', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': [] } });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let errors;',
          "const bad = [() => sdk.services.provide({ name: 'x', version: '1', methods: ['a'] }, () => {}), () => sdk.services.connect({ name: 'x', version: '1', method: 'a' })];",
          'Promise.all(bad.map((fn) => fn().then(undefined, (e) => e.code)))',
          '  .then((codes) => { errors = codes; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['errors']).toEqual(['CAPABILITY_DENIED', 'CAPABILITY_DENIED']);
      },
    );
  });

  it('validates service inputs in the worker before they reach the wire', async () => {
    const received: BrokerCallRequest[] = [];
    const host = createMemoryHostExecutor({
      grants: { 'test.broker': ['services.provide', 'services.connect'] },
    });
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let errors;',
          'const bad = [',
          "  () => sdk.services.provide({ name: '', version: '1', methods: ['a'] }, () => {}),",
          "  () => sdk.services.provide({ name: 'x', version: '1', methods: [] }, () => {}),",
          "  () => sdk.services.provide({ name: 'x', version: '1', methods: ['a', 'a'] }, () => {}),",
          "  () => sdk.services.connect({ name: 'x', version: '', method: 'a' }),",
          "  () => sdk.services.connect({ name: 'x', version: '1', method: 'a', deadlineMs: 0 }),",
          '];',
          'Promise.all(bad.map((fn) => fn().then(undefined, (e) => e.code)))',
          '  .then((codes) => { errors = codes; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['errors']).toEqual([
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
        ]);
        expect(received).toHaveLength(0);
      },
    );
  });
});

describe('worker core sdk (secrets, §33 Stage E)', () => {
  const stubProvider: SecretsProvider = {
    async use(pluginId, connectionId) {
      return {
        serviceId: 'com.example.api',
        origin: 'https://api.example.com',
        headers: { Authorization: `Bearer ${pluginId}:${connectionId}` },
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
      ].filter(() => pluginId === 'test.broker');
    },
    async reveal(pluginId, connectionId) {
      return { accessToken: `raw-${connectionId}`, tokenType: 'Bearer', expiresAt: null };
    },
  };

  it('mints a secret handle and lists own connections through the typed sdk', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'test.broker': ['secrets.use', 'secrets.manageOwn', 'secrets.reveal'] },
      secretsProvider: stubProvider,
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.secrets.use({ connectionId: 'conn-1' })",
          '  .then((used) => sdk.secrets.manageOwn().then((listed) => ({ used, listed })))',
          '  .then(({ used, listed }) => {',
          '    result = { handle: used.handle, serviceId: used.serviceId, count: listed.connections.length };',
          '  })',
          '  .catch((err) => { result = { error: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const result = message.snapshot['result'] as {
          handle: string;
          serviceId: string;
          count: number;
        };
        expect(result.handle).toMatch(/^sec-/);
        expect(result.serviceId).toBe('com.example.api');
        expect(result.count).toBe(1);
      },
    );
  });

  it('refuses reveal for a sandboxed caller even with the grant', async () => {
    const host = createMemoryHostExecutor({
      grants: { 'test.broker': ['secrets.use', 'secrets.manageOwn', 'secrets.reveal'] },
      secretsProvider: stubProvider,
    });
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.secrets.reveal({ connectionId: 'conn-1' })",
          '  .then((revealed) => { result = { accessToken: revealed.accessToken }; })',
          '  .catch((err) => { result = { error: err.code }; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        // The worker's trust level is sandbox; the executor gates reveal.
        expect((message.snapshot['result'] as { error: string }).error).toBe('TRUST_REQUIRED');
      },
    );
  });

  it('validates secrets inputs in the worker before they reach the wire', async () => {
    const received: BrokerCallRequest[] = [];
    const host = createMemoryHostExecutor({
      grants: { 'test.broker': ['secrets.use'] },
      secretsProvider: stubProvider,
    });
    const executor = host.policy;
    const policy = {
      authorize: executor.authorize.bind(executor),
      execute: async (call: BrokerCallRequest, signal: AbortSignal) => {
        received.push(call);
        return executor.execute(call, signal);
      },
    };
    await withBrokerWorker(
      {
        'src/index.js': [
          'export let errors;',
          "const bad = [() => sdk.secrets.use({}), () => sdk.secrets.use({ connectionId: '' }), () => sdk.secrets.use({ connectionId: 42 })];",
          'Promise.all(bad.map((fn) => fn().then(undefined, (e) => e.code)))',
          '  .then((codes) => { errors = codes; });',
        ].join('\n'),
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot['errors']).toEqual([
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
          'VALIDATION_FAILED',
        ]);
        expect(received).toHaveLength(0);
      },
    );
  });
});
