/**
 * Unit tests for the host-forwarding broker core (Stage D part 9b): every
 * admitted call is relayed host-ward as an RPC_REQUEST frame, worker-side
 * promises settle from RPC_RESPONSE frames, and revoke/deadline/shutdown/
 * worker-exit abort in-flight calls.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type {
  BrokerCallRequest,
  PluginRuntimeRpcRequestBody,
  PluginRuntimeRpcResponseBody,
} from '@neotavern/contracts';
import { createHostForwardingCore, type HostForwardingCore } from './hostForwardingCore.js';

const PLUGIN_ID = 'plugin-a';
const WORKER = { workerId: 3, workerEpoch: 1 };

function call(overrides: Partial<BrokerCallRequest> = {}): BrokerCallRequest {
  return {
    requestId: 'req-00000001',
    caller: { pluginId: PLUGIN_ID, installationId: 'install-1', trustLevel: 'sandbox' },
    method: 'storage.kv.get',
    args: { key: 'k' },
    capability: { name: 'storage.kv', scope: {} },
    revision: 1,
    deadlineAt: Date.now() + 10_000,
    causalChain: [],
    ...overrides,
  };
}

function response(
  requestId: string,
  overrides: Partial<PluginRuntimeRpcResponseBody> = {},
): PluginRuntimeRpcResponseBody {
  return {
    workerId: WORKER.workerId,
    workerEpoch: WORKER.workerEpoch,
    requestId,
    ok: true,
    ...overrides,
  };
}

function pending(core: HostForwardingCore): Promise<unknown> {
  const handle = core.submit(call(), WORKER);
  return handle.promise;
}

let core: HostForwardingCore;
let sent: PluginRuntimeRpcRequestBody[];
let clock: { at: number };

function forwardedBody(): PluginRuntimeRpcRequestBody {
  const body = sent[0];
  if (!body) throw new Error('expected a forwarded RPC_REQUEST');
  return body;
}

beforeEach(() => {
  sent = [];
  clock = { at: Date.now() };
  core = createHostForwardingCore({
    now: () => clock.at,
    sendRpcRequest: (body) => sent.push(body),
  });
});

describe('host-ward relay', () => {
  it('ships an admitted call as an RPC_REQUEST frame stamped with the worker', () => {
    const request = call();
    core.submit(request, WORKER);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      workerId: WORKER.workerId,
      workerEpoch: WORKER.workerEpoch,
      call: { requestId: request.requestId, method: request.method },
    });
  });

  it('does not send anything for calls rejected at admission', () => {
    core.submit(call({ deadlineAt: clock.at - 1 }), WORKER).promise.catch(() => undefined);
    core
      .submit(call({ causalChain: [PLUGIN_ID, 'plugin-b'] }), WORKER)
      .promise.catch(() => undefined);
    expect(sent).toHaveLength(0);
  });

  it('resolves the worker-side promise from a matching RPC_RESPONSE', async () => {
    const promise = pending(core);
    const body = forwardedBody();
    const done = vi.fn();
    promise.then(done);
    expect(core.handleRpcResponse(response(body.call.requestId, { ok: true, result: 42 }))).toBe(
      true,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toHaveBeenCalledWith(42);
  });

  it('rejects with the wire error from a failed RPC_RESPONSE', async () => {
    const promise = pending(core);
    const body = forwardedBody();
    core.handleRpcResponse(
      response(body.call.requestId, {
        ok: false,
        error: {
          code: 'CAPABILITY_DENIED',
          message: 'nope',
          retryable: false,
          details: { capability: 'storage.kv' },
        },
      }),
    );
    await expect(promise).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      message: 'nope',
      details: { capability: 'storage.kv' },
    });
  });

  it('returns false and settles nothing for an unknown requestId', async () => {
    const promise = pending(core);
    expect(core.handleRpcResponse(response('req-99999999'))).toBe(false);
    const marker = vi.fn();
    promise.then(marker, marker);
    await Promise.resolve();
    await Promise.resolve();
    expect(marker).not.toHaveBeenCalled();
  });

  it('drops responses that race a worker restart (epoch mismatch)', async () => {
    const promise = pending(core);
    const body = forwardedBody();
    expect(
      core.handleRpcResponse(
        response(body.call.requestId, { workerEpoch: WORKER.workerEpoch + 1 }),
      ),
    ).toBe(false);
    const marker = vi.fn();
    promise.then(marker, marker);
    await Promise.resolve();
    await Promise.resolve();
    expect(marker).not.toHaveBeenCalled();
  });
});

describe('admission (protocol-level envelope)', () => {
  it('rejects an expired deadline with OPERATION_DEADLINE', async () => {
    await expect(
      core.submit(call({ deadlineAt: clock.at - 1 }), WORKER).promise,
    ).rejects.toMatchObject({ code: 'OPERATION_DEADLINE' });
  });

  it('rejects deadlines beyond the broker cap with VALIDATION_FAILED', async () => {
    await expect(
      core.submit(call({ deadlineAt: clock.at + 61_000 }), WORKER).promise,
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a causal cycle with SERVICE_CALL_CYCLE', async () => {
    await expect(
      core.submit(call({ causalChain: [PLUGIN_ID] }), WORKER).promise,
    ).rejects.toMatchObject({ code: 'SERVICE_CALL_CYCLE' });
  });

  it('rejects duplicate in-flight requestIds', async () => {
    core.submit(call(), WORKER);
    await expect(core.submit(call(), WORKER).promise).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('fails with OPERATION_DEADLINE while awaiting the host', async () => {
    const deadline = clock.at + 2_000;
    const promise = core.submit(call({ deadlineAt: deadline }), WORKER).promise;
    clock.at = deadline + 1;
    await expect(promise).rejects.toMatchObject({ code: 'OPERATION_DEADLINE' });
    expect(core.pendingCount()).toBe(0);
  });
});

describe('revoke (host-driven)', () => {
  it('records the revoked pair and rejects new calls', async () => {
    core.revoke(PLUGIN_ID, 'storage.kv', 'user said no');
    expect(core.isRevoked(PLUGIN_ID, 'storage.kv')).toBe(true);
    await expect(core.submit(call(), WORKER).promise).rejects.toMatchObject({
      code: 'CAPABILITY_REVOKED',
    });
  });

  it('aborts matching in-flight calls and reports the count', async () => {
    const promise = pending(core);
    expect(core.pendingCount()).toBe(1);
    expect(core.revoke(PLUGIN_ID, 'storage.kv', 'user said no')).toBe(1);
    await expect(promise).rejects.toMatchObject({ code: 'CAPABILITY_REVOKED' });
    expect(core.pendingCount()).toBe(0);
  });

  it('leaves unrelated in-flight calls alone when revoking one capability', async () => {
    const kv = pending(core);
    const other = core.submit(
      call({
        requestId: 'req-00000002',
        method: 'settings.get',
        capability: { name: 'settings', scope: {} },
      }),
      WORKER,
    ).promise;
    expect(core.revoke(PLUGIN_ID, 'storage.kv')).toBe(1);
    await expect(kv).rejects.toMatchObject({ code: 'CAPABILITY_REVOKED' });
    const marker = vi.fn();
    other.then(marker, marker);
    await Promise.resolve();
    expect(marker).not.toHaveBeenCalled();
  });

  it('revokes everything of a plugin when name is omitted', async () => {
    const first = core.submit(call(), WORKER).promise;
    const second = core.submit(
      call({
        requestId: 'req-00000002',
        method: 'settings.get',
        capability: { name: 'settings', scope: {} },
      }),
      WORKER,
    ).promise;
    expect(core.revoke(PLUGIN_ID)).toBe(2);
    expect(core.pendingCount()).toBe(0);
    expect(core.isRevoked(PLUGIN_ID, 'settings')).toBe(true);
    await expect(first).rejects.toMatchObject({ code: 'CAPABILITY_REVOKED' });
    await expect(second).rejects.toMatchObject({ code: 'CAPABILITY_REVOKED' });
  });
});

describe('worker lifecycle and shutdown', () => {
  it('aborts in-flight calls of a terminated worker instance', async () => {
    const promise = pending(core);
    expect(core.abortWorker(WORKER.workerId, WORKER.workerEpoch)).toBe(1);
    await expect(promise).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('leaves in-flight calls of other workers alone', async () => {
    const own = core.submit(call(), WORKER).promise;
    const other = core.submit(call({ requestId: 'req-00000002' }), {
      workerId: 9,
      workerEpoch: 1,
    }).promise;
    other.catch(() => undefined);
    expect(core.abortWorker(WORKER.workerId, WORKER.workerEpoch)).toBe(1);
    expect(core.pendingCount()).toBe(1);
    await expect(own).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('aborts every in-flight call on shutdown', async () => {
    const promise = pending(core);
    core.shutdown();
    await expect(promise).rejects.toMatchObject({ code: 'CAPABILITY_REVOKED' });
    expect(core.pendingCount()).toBe(0);
  });

  it('caps concurrent in-flight calls with SERVICE_UNAVAILABLE', async () => {
    const small = createHostForwardingCore({
      now: () => clock.at,
      maxInflight: 1,
      sendRpcRequest: (body) => sent.push(body),
    });
    small.submit(call(), WORKER);
    await expect(
      small.submit(call({ requestId: 'req-00000002' }), WORKER).promise,
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('settled handles stay settled', () => {
  it('ignores a late response after a revoke abort', async () => {
    const promise = pending(core);
    const body = forwardedBody();
    core.revoke(PLUGIN_ID, 'storage.kv');
    await expect(promise).rejects.toMatchObject({ code: 'CAPABILITY_REVOKED' });
    expect(
      core.handleRpcResponse(response(body.call.requestId, { ok: true, result: 'late' })),
    ).toBe(false);
  });

  it('ignores a late abort after a successful response', async () => {
    const promise = pending(core);
    const body = forwardedBody();
    core.handleRpcResponse(response(body.call.requestId, { ok: true, result: 1 }));
    await expect(promise).resolves.toBe(1);
    expect(core.revoke(PLUGIN_ID, 'storage.kv')).toBe(0);
    await expect(promise).resolves.toBe(1);
  });
});
