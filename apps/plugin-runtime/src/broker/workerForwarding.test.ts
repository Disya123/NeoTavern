/**
 * Host-ward relay end-to-end tests (Stage D part 9b, ТЗ §10, §15.2, ADR-0027).
 *
 * The same real-worker harness as the broker/SDK tests, but the broker
 * decision travels the production wire shape: the runtime forwards the call
 * host-ward as an RPC_REQUEST and settles the worker-side promise from the
 * host's RPC_RESPONSE. Pins: round-trips, host-authoritative denial, and the
 * revoke-abort (B14) crossing the wire.
 */
import { describe, expect, it } from 'vitest';
import { BrokerErrorCode } from './capabilityBroker.js';
import { createMemoryHostExecutor } from '../host/memoryHost.js';
import { withForwardingWorker, type ModuleGraphLoaded } from './workerTestUtil.js';

describe('host-ward broker relay (part 9b)', () => {
  it('round-trips KV values over the forwarding path', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': ['storage.kv'] } });
    await withForwardingWorker(
      {
        'src/index.js': [
          'export let result;',
          "sdk.kv.set('greeting', { text: 'hello' })",
          "  .then(() => sdk.kv.get('greeting'))",
          '  .then((value) => { result = value; });',
        ].join('\n'),
      },
      host.policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot).toEqual({ result: { value: { text: 'hello' } } });
        expect(host.kvSnapshot('test.broker')).toEqual({ greeting: { text: 'hello' } });
      },
    );
  });

  it('delivers a host-side denial through the wire (decision stays in Main Host)', async () => {
    const host = createMemoryHostExecutor({ grants: { 'test.broker': ['storage.kv'] } });
    await withForwardingWorker(
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

  it('aborts an in-flight call host-ward when the capability is revoked (B14, §10.2)', async () => {
    let markStarted: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolveStart) => {
      markStarted = resolveStart;
    });
    const policy = {
      authorize: () => ({ allowed: true }) as const,
      execute: (call: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          markStarted();
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    };
    await withForwardingWorker(
      {
        'src/index.js':
          "export let error;\nbridge.invoke('long', {}, { capability: 'jobs.background', deadlineMs: 30000 }).then(undefined, (err) => { error = { code: err.code, message: err.message }; });\n",
      },
      policy,
      {},
      async ({ gateway, hostCore, load }) => {
        const pending = load();
        await startedPromise;
        // The host owns the decision: it aborts its own in-flight call first
        // (ADR-0027), then tells the runtime via the BROKER_REVOKE frame
        // (runtime-main calls gateway.revoke on that frame). The response
        // microtask has not landed yet, so the runtime still sees the call
        // in-flight and aborts it locally with the same code.
        expect(hostCore.revoke('test.broker', 'jobs.background', 'user revoked')).toBe(1);
        expect(gateway.revoke('test.broker', 'jobs.background', 'user revoked')).toBe(1);
        const message = (await pending) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const error = message.snapshot['error'] as { code?: string; message?: string };
        expect(error.code).toBe(BrokerErrorCode.CAPABILITY_REVOKED);
      },
    );
  });
});
