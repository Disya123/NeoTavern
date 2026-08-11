/**
 * Worker broker end-to-end tests (Stage C, ТЗ §10, §16).
 *
 * Spawns a REAL Worker through the supervisor and exercises the full call
 * path: plugin module → hardened `bridge` endowment → worker bridge →
 * supervisor → broker gateway → broker core → injected policy → reply → the
 * module's export snapshot. Also covers the §10.2 revoke race (B14) and the
 * §26.2.1 cycle fail-fast inside the live worker.
 *
 * SES Compartments do not support top-level await, so the test modules export
 * a live binding that a `.then` callback fills in; the bootstrap reports
 * `module-graph-loaded` only after import-time broker calls have settled, so
 * the snapshot already contains the observed value.
 */
import { describe, expect, it } from 'vitest';
import type { BrokerCallRequest } from '@neotavern/contracts';
import { BrokerErrorCode, type BrokerPolicy } from './capabilityBroker.js';
import { withBrokerWorker, type ModuleGraphLoaded } from './workerTestUtil.js';

describe('worker capability broker calls', () => {
  it('round-trips a broker call through the live worker (§10 flow)', async () => {
    const received: BrokerCallRequest[] = [];
    const policy: BrokerPolicy = {
      authorize: () => ({ allowed: true }),
      execute: async (call) => {
        received.push(call);
        return { echo: call.args };
      },
    };
    await withBrokerWorker(
      {
        'src/index.js':
          "export let result;\nbridge.invoke('echo', { hello: 'world' }, { capability: 'services.connect' }).then((value) => { result = value; });\n",
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(message.snapshot).toEqual({ result: { echo: { hello: 'world' } } });

        expect(received).toHaveLength(1);
        const call = received[0]!;
        expect(call.caller.pluginId).toBe('test.broker');
        expect(call.caller.installationId).toBe('inst-broker');
        expect(call.caller.trustLevel).toBe('sandbox');
        expect(call.method).toBe('echo');
        expect(call.capability).toEqual({ name: 'services.connect' });
        expect(call.causalChain).toEqual([]);
        expect(call.deadlineAt).toBeGreaterThan(Date.now());
      },
    );
  });

  it('propagates the spawn-time trust level into the caller identity (§11)', async () => {
    const received: BrokerCallRequest[] = [];
    const policy: BrokerPolicy = {
      authorize: () => ({ allowed: true }),
      execute: async (call) => {
        received.push(call);
        return { ok: true };
      },
    };
    await withBrokerWorker(
      {
        'src/index.js':
          "export let result;\nbridge.invoke('ping', undefined, { capability: 'network.http' }).then((value) => { result = value; });\n",
      },
      policy,
      { trustLevel: 'extended' },
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        expect(received[0]?.caller.trustLevel).toBe('extended');
        expect(received[0]?.capability.name).toBe('network.http');
      },
    );
  });

  it('delivers CAPABILITY_DENIED to plugin code when the policy denies', async () => {
    const policy: BrokerPolicy = {
      authorize: () => ({ allowed: false, code: BrokerErrorCode.CAPABILITY_DENIED }),
      execute: async () => 'unreachable',
    };
    await withBrokerWorker(
      {
        'src/index.js':
          "export let error;\nbridge.invoke('read', {}, { capability: 'chats.read.all' }).then(undefined, (err) => { error = { code: err.code, message: err.message }; });\n",
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const error = message.snapshot['error'] as { code?: string; message?: string };
        expect(error.code).toBe(BrokerErrorCode.CAPABILITY_DENIED);
        expect(error.message).toContain(BrokerErrorCode.CAPABILITY_DENIED);
      },
    );
  });

  it('aborts an in-flight call when the capability is revoked (B14, §10.2)', async () => {
    let markStarted: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolveStart) => {
      markStarted = resolveStart;
    });
    const policy: BrokerPolicy = {
      authorize: () => ({ allowed: true }),
      execute: (call, signal) =>
        new Promise((_resolve, reject) => {
          markStarted();
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    };
    await withBrokerWorker(
      {
        'src/index.js':
          "export let error;\nbridge.invoke('long', {}, { capability: 'jobs.background', deadlineMs: 30000 }).then(undefined, (err) => { error = { code: err.code, message: err.message }; });\n",
      },
      policy,
      {},
      async ({ gateway, load }) => {
        const pending = load();
        await startedPromise;
        const aborted = gateway.revoke('test.broker', 'jobs.background', 'user revoked');
        expect(aborted).toBe(1);
        const message = (await pending) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const error = message.snapshot['error'] as { code?: string; message?: string };
        expect(error.code).toBe(BrokerErrorCode.CAPABILITY_REVOKED);
      },
    );
  });

  it('fails fast with SERVICE_CALL_CYCLE inside the worker (§26.2.1)', async () => {
    const policy: BrokerPolicy = {
      authorize: () => ({ allowed: true }),
      execute: async () => 'unreachable',
    };
    await withBrokerWorker(
      {
        'src/index.js':
          "export let error;\nbridge.invoke('connect', {}, { capability: 'services.connect', causalChain: ['test.broker'] }).then(undefined, (err) => { error = { code: err.code, message: err.message }; });\n",
      },
      policy,
      {},
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        const error = message.snapshot['error'] as { code?: string; message?: string };
        expect(error.code).toBe(BrokerErrorCode.SERVICE_CALL_CYCLE);
      },
    );
  });
});
