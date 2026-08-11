/**
 * Capability Broker core unit tests (Stage C, ТЗ §10–§11, §26.2.1, B14).
 *
 * Exercises the admission checks and the §10.2 revoke semantics without any
 * worker: the policy is injected directly into the core.
 */
import { describe, expect, it } from 'vitest';
import type { BrokerCallRequest } from '@neotavern/contracts';
import {
  assertBrokerCallShape,
  BrokerCallError,
  BrokerErrorCode,
  createCapabilityBrokerCore,
  toBrokerError,
  type BrokerPolicy,
} from './capabilityBroker.js';

function makeCall(overrides: Partial<BrokerCallRequest> = {}): BrokerCallRequest {
  return {
    requestId: 'req-0001-aaaaaaaa',
    caller: { pluginId: 'plugin-a', installationId: 'inst-a', trustLevel: 'sandbox' },
    method: 'echo',
    args: { x: 1 },
    capability: { name: 'services.connect' },
    deadlineAt: Date.now() + 10_000,
    causalChain: [],
    ...overrides,
  };
}

function echoPolicy(overrides: Partial<BrokerPolicy> = {}): BrokerPolicy {
  return {
    authorize: () => ({ allowed: true }),
    execute: async (call) => ({ echo: call.args }),
    ...overrides,
  };
}

/** Assert the stable machine code of a rejection (not its message). */
function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

describe('capability broker core', () => {
  it('admits a call and returns the policy result', async () => {
    const core = createCapabilityBrokerCore(echoPolicy());
    const handle = core.submit(makeCall());
    await expect(handle.promise).resolves.toEqual({ echo: { x: 1 } });
    expect(core.pendingCount()).toBe(0);
  });

  it('relays CAPABILITY_DENIED from the policy', async () => {
    const core = createCapabilityBrokerCore(
      echoPolicy({
        authorize: () => ({ allowed: false, code: BrokerErrorCode.CAPABILITY_DENIED }),
      }),
    );
    await expectCode(core.submit(makeCall()).promise, BrokerErrorCode.CAPABILITY_DENIED);
  });

  it('relays TRUST_REQUIRED from the policy with the caller trust level visible', async () => {
    const trustLevelsSeen: string[] = [];
    const core = createCapabilityBrokerCore(
      echoPolicy({
        authorize: (call) => {
          trustLevelsSeen.push(call.caller.trustLevel);
          return {
            allowed: false,
            code: BrokerErrorCode.TRUST_REQUIRED,
            details: { needed: 'extended' },
          };
        },
      }),
    );
    const handle = core.submit(
      makeCall({
        caller: { pluginId: 'plugin-a', installationId: 'inst-a', trustLevel: 'sandbox' },
      }),
    );
    await expectCode(handle.promise, BrokerErrorCode.TRUST_REQUIRED);
    expect(trustLevelsSeen).toEqual(['sandbox']);
  });

  it('relays POLICY_DENIED (admin override / consent state)', async () => {
    const core = createCapabilityBrokerCore(
      echoPolicy({ authorize: () => ({ allowed: false, code: BrokerErrorCode.POLICY_DENIED }) }),
    );
    await expectCode(core.submit(makeCall()).promise, BrokerErrorCode.POLICY_DENIED);
  });

  it('fails fast with SERVICE_CALL_CYCLE when the chain already contains the caller (§26.2.1)', async () => {
    const core = createCapabilityBrokerCore(echoPolicy());
    const handle = core.submit(
      makeCall({
        causalChain: ['plugin-b', 'plugin-a'],
        caller: { pluginId: 'plugin-a', installationId: 'inst-a', trustLevel: 'sandbox' },
      }),
    );
    await expectCode(handle.promise, BrokerErrorCode.SERVICE_CALL_CYCLE);
    expect(core.pendingCount()).toBe(0);
  });

  it('allows a linear A→B→C chain', async () => {
    const core = createCapabilityBrokerCore(echoPolicy());
    const handle = core.submit(
      makeCall({
        caller: { pluginId: 'plugin-c', installationId: 'inst-c', trustLevel: 'sandbox' },
        causalChain: ['plugin-a', 'plugin-b'],
      }),
    );
    await expect(handle.promise).resolves.toEqual({ echo: { x: 1 } });
  });

  it('rejects a call whose deadline already passed', async () => {
    const fixedNow = 1_000_000;
    const core = createCapabilityBrokerCore(echoPolicy(), { now: () => fixedNow });
    const handle = core.submit(makeCall({ deadlineAt: fixedNow - 1 }));
    await expectCode(handle.promise, BrokerErrorCode.OPERATION_DEADLINE);
  });

  it('rejects a call whose deadline exceeds the broker cap', async () => {
    const fixedNow = 1_000_000;
    const core = createCapabilityBrokerCore(echoPolicy(), { now: () => fixedNow });
    const handle = core.submit(makeCall({ deadlineAt: fixedNow + 60_001 }));
    await expectCode(handle.promise, BrokerErrorCode.VALIDATION_FAILED);
  });

  it('aborts an in-flight call on revoke (B14 revoke race)', async () => {
    const gate = { release: (): void => undefined };
    const policy = echoPolicy({
      execute: (call, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
          gate.release = () => resolve('done');
        }),
    });
    const core = createCapabilityBrokerCore(policy);
    const handle = core.submit(makeCall());
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    expect(core.pendingCount()).toBe(1);

    const aborted = core.revoke('plugin-a', 'services.connect', 'user revoked');
    expect(aborted).toBe(1);
    expect(core.pendingCount()).toBe(0);
    await expectCode(handle.promise, BrokerErrorCode.CAPABILITY_REVOKED);
  });

  it('rejects new calls for a revoked capability and never re-admits them', async () => {
    const core = createCapabilityBrokerCore(echoPolicy());
    core.revoke('plugin-a', 'services.connect');
    expect(core.isRevoked('plugin-a', 'services.connect')).toBe(true);
    expect(core.isRevoked('plugin-a', 'other.cap')).toBe(false);
    // The revoke applies even if the policy would allow the call.
    await expectCode(core.submit(makeCall()).promise, BrokerErrorCode.CAPABILITY_REVOKED);
    await expectCode(core.submit(makeCall()).promise, BrokerErrorCode.CAPABILITY_REVOKED);
  });

  it('revoking a whole plugin kills every capability of it', async () => {
    const core = createCapabilityBrokerCore(echoPolicy());
    core.revoke('plugin-a');
    await expectCode(core.submit(makeCall()).promise, BrokerErrorCode.CAPABILITY_REVOKED);
    await expectCode(
      core.submit(makeCall({ capability: { name: 'files.plugin' } })).promise,
      BrokerErrorCode.CAPABILITY_REVOKED,
    );
  });

  it('aborts a hung operation when the in-flight deadline fires', async () => {
    const policy = echoPolicy({
      execute: (call, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    const core = createCapabilityBrokerCore(policy);
    const handle = core.submit(makeCall({ deadlineAt: Date.now() + 30 }));
    await expectCode(handle.promise, BrokerErrorCode.OPERATION_DEADLINE);
    expect(core.pendingCount()).toBe(0);
  });

  it('rejects duplicate in-flight requestIds', async () => {
    const policy = echoPolicy({
      execute: () => new Promise(() => undefined),
    });
    const core = createCapabilityBrokerCore(policy);
    const call = makeCall();
    core.submit(call);
    await expectCode(core.submit(call).promise, BrokerErrorCode.VALIDATION_FAILED);
    core.shutdown();
  });

  it('shutdown aborts every in-flight call', async () => {
    const policy = echoPolicy({
      execute: (call, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    const core = createCapabilityBrokerCore(policy);
    const first = core.submit(makeCall());
    const second = core.submit(makeCall({ requestId: 'req-0002-bbbbbbbb' }));
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    expect(core.pendingCount()).toBe(2);
    core.shutdown();
    await expectCode(first.promise, BrokerErrorCode.CAPABILITY_REVOKED);
    await expectCode(second.promise, BrokerErrorCode.CAPABILITY_REVOKED);
    expect(core.pendingCount()).toBe(0);
  });
});

describe('broker error normalization', () => {
  it('degrades unknown errors to INTERNAL without leaking details', () => {
    const wire = toBrokerError(new Error('some internal host failure'));
    expect(wire.code).toBe(BrokerErrorCode.INTERNAL);
    expect(wire.retryable).toBe(false);
    expect(wire.message).toBe('some internal host failure');
  });

  it('keeps stable §41 codes when the error message is a code', () => {
    const wire = toBrokerError(
      new BrokerCallError(BrokerErrorCode.SERVICE_CALL_CYCLE, {
        details: { chain: ['a', 'b'] },
      }),
    );
    expect(wire.code).toBe(BrokerErrorCode.SERVICE_CALL_CYCLE);
    expect(wire.details).toEqual({ chain: ['a', 'b'] });
    expect(wire.message).toBe(BrokerErrorCode.SERVICE_CALL_CYCLE);
  });
});

describe('broker envelope shape guard', () => {
  it('accepts a well-formed call', () => {
    expect(assertBrokerCallShape(makeCall())).toBe(true);
  });

  it('rejects malformed envelopes', () => {
    expect(assertBrokerCallShape(null)).toBe(false);
    expect(assertBrokerCallShape({ kind: 'rpc-request' })).toBe(false);
    expect(assertBrokerCallShape({ ...makeCall(), caller: { pluginId: 'p' } })).toBe(false);
    expect(
      assertBrokerCallShape({
        ...makeCall(),
        caller: { pluginId: 'p', installationId: 'i', trustLevel: 'root' },
      }),
    ).toBe(false);
    expect(assertBrokerCallShape({ ...makeCall(), causalChain: [42] })).toBe(false);
    expect(assertBrokerCallShape({ ...makeCall(), requestId: 'short' })).toBe(false);
    expect(
      assertBrokerCallShape({
        ...makeCall(),
        causalChain: Array.from({ length: 17 }, (_, i) => `p${i}`),
      }),
    ).toBe(false);
  });
});
