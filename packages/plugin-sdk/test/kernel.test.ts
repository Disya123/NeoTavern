/**
 * Kernel contract tests: version negotiation, capabilities, limits, protocol
 * envelopes, the RPC session and credit-based streams (rev4 §A–D, §O1/O2).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  KernelError,
  KernelErrorCode,
  fromWireError,
  parseWireError,
  toWireError,
} from '../src/kernel/errors.js';
import { DEFAULT_PLUGIN_LIMITS, getLimit, mergeLimits } from '../src/kernel/limits.js';
import {
  featureSupported,
  parseRange,
  parseVersion,
  protocolCompatible,
  satisfiesRange,
} from '../src/kernel/version.js';
import {
  diffCapabilities,
  grantSatisfies,
  parseCapability,
  parseCapabilityScope,
} from '../src/kernel/capabilities.js';
import {
  MAX_ENVELOPE_BYTES,
  PROTOCOL_VERSION,
  envelopeFitsBudget,
  parseEnvelope,
} from '../src/kernel/protocol.js';
import { KernelSession } from '../src/kernel/session.js';
import { createPortPair } from './kernelPorts.js';

function createSessionPair(): {
  host: KernelSession;
  plugin: KernelSession;
  dispose: () => void;
} {
  const [hostPort, pluginPort] = createPortPair();
  const host = new KernelSession(hostPort as unknown as MessagePort, {
    instanceId: 'host',
    role: 'host',
  });
  const plugin = new KernelSession(pluginPort as unknown as MessagePort, {
    instanceId: 'plugin',
    role: 'plugin',
  });
  return {
    host,
    plugin,
    dispose: () => {
      host.dispose();
      plugin.dispose();
    },
  };
}

describe('kernel errors', () => {
  it('serializes to a stable wire shape and rehydrates', () => {
    const error = new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
      retryAfterMs: 500,
      details: { limit: 'streams.maxConcurrent', max: 4 },
    });
    const wire = error.toWire();
    expect(wire.code).toBe('PLUGIN_QUOTA_EXCEEDED');
    expect(wire.retryable).toBe(true);
    expect(wire.retryAfterMs).toBe(500);
    const back = fromWireError(wire);
    expect(back.code).toBe('PLUGIN_QUOTA_EXCEEDED');
    expect(back.retryable).toBe(true);
    expect(back.retryAfterMs).toBe(500);
  });

  it('keeps stable machine codes for CAS and idempotency conflicts', () => {
    // Wire codes are contract: hosts and sandboxes match on the exact string.
    expect(KernelErrorCode.REVISION_CONFLICT).toBe('REVISION_CONFLICT');
    expect(KernelErrorCode.IDEMPOTENCY_CONFLICT).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('marks abort errors non-retryable', () => {
    const abort = new Error('AbortError');
    abort.name = 'AbortError';
    const wire = toWireError(abort);
    expect(wire.code).toBe('OPERATION_ABORTED');
    expect(wire.retryable).toBe(false);
  });

  it('parses wire errors defensively and drops garbage', () => {
    expect(parseWireError(null)).toBeNull();
    expect(parseWireError({ retryable: true })).toBeNull();
    const parsed = parseWireError({ code: 'X', retryable: 'yes', retryAfterMs: -5, junk: 1 });
    expect(parsed).not.toBeNull();
    expect(parsed?.retryable).toBe(false);
    expect(parsed?.retryAfterMs).toBe(0);
    expect(parsed?.details).toBeUndefined();
  });
});

describe('version negotiation', () => {
  it('parses and compares versions', () => {
    expect(parseVersion('2.4.0')).toEqual({ major: 2, minor: 4, patch: 0 });
    expect(parseVersion('2.4.0-beta')).toBeNull();
    expect(parseVersion('2.4')).toBeNull();
  });

  it('satisfies caret and comparator ranges', () => {
    expect(satisfiesRange('1.3.0', '^1.3.0')).toBe(true);
    expect(satisfiesRange('1.9.9', '^1.3.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.3.0')).toBe(false);
    expect(satisfiesRange('0.3.0', '^0.2.0')).toBe(false);
    expect(satisfiesRange('2.4.0', '>=2.4.0 <3')).toBe(true);
    expect(satisfiesRange('3.0.0', '>=2.4.0 <3')).toBe(false);
    expect(satisfiesRange('9.9.9', '*')).toBe(true);
  });

  it('rejects malformed ranges', () => {
    expect(parseRange('^not-a-version')).toBeNull();
    expect(satisfiesRange('2.4.0', '^not-a-version')).toBe(false);
  });

  it('requires matching protocol major and non-newer minor', () => {
    expect(protocolCompatible('2.0.0', '2.1.0')).toBe(true);
    expect(protocolCompatible('2.1.0', '2.0.0')).toBe(false);
    expect(protocolCompatible('3.0.0', '2.9.0')).toBe(false);
  });

  it('parses the advertised protocol version', () => {
    // PROTOCOL_VERSION must survive the strict x.y.z parser it is negotiated with.
    expect(parseVersion(PROTOCOL_VERSION)).not.toBeNull();
  });

  it('feature detection compares available vs required', () => {
    const features = { 'ui.overlays.native-regions': 1 };
    expect(featureSupported(features, 'ui.overlays.native-regions', 1)).toBe(true);
    expect(featureSupported(features, 'ui.overlays.native-regions', 2)).toBe(false);
    expect(featureSupported(features, 'unknown', 1)).toBe(false);
  });
});

describe('capability model', () => {
  it('parses catalog names and legacy aliases', () => {
    expect(parseCapability('ui.panel')?.name).toBe('ui.panel');
    expect(parseCapability('chat.read')?.name).toBe('chats.read.current');
    expect(parseCapability('ui.toolbar')?.name).toBe('ui.commands');
    expect(parseCapability('not-a-capability')).toBeNull();
  });

  it('maps network scopes into origins', () => {
    const single = parseCapability('network:api.example.com');
    expect(single?.name).toBe('network.domains');
    expect(single?.scope).toEqual({ kind: 'origins', origins: ['https://api.example.com'] });
    const wild = parseCapability('network:*');
    expect(wild?.scope).toEqual({ kind: 'all' });
  });

  it('never grants legacy.trusted through a manifest', () => {
    expect(parseCapability('legacy.trusted')).toBeNull();
  });

  it('parses scope shorthands and objects', () => {
    expect(parseCapabilityScope('current-chat')).toEqual({ kind: 'current-chat' });
    expect(parseCapabilityScope({ kind: 'chat', chatId: 'c1' })).toEqual({
      kind: 'chat',
      chatId: 'c1',
    });
    expect(parseCapabilityScope('bogus')).toBeUndefined();
  });

  it('grant satisfies request when scope covers it', () => {
    const grant = {
      name: 'chats.read.selected',
      scope: { kind: 'selected-chats' as const, chatIds: ['c1', 'c2'] },
      revision: 1,
      grantedAt: 0,
    };
    expect(grantSatisfies(grant, { name: 'chats.read.selected' })).toBe(true);
    expect(grantSatisfies(grant, { name: 'chats.read.all' })).toBe(false);
  });

  it('diffs capabilities between manifests', () => {
    const diff = diffCapabilities(
      [{ name: 'ui.panel' }],
      [{ name: 'ui.panel' }, { name: 'chats.read.current' }],
    );
    expect(diff.added.map((c) => c.name)).toEqual(['chats.read.current']);
    expect(diff.removed).toEqual([]);
  });
});

describe('limits', () => {
  it('reads nested limit paths', () => {
    expect(getLimit(DEFAULT_PLUGIN_LIMITS, 'storage.maxBlobFileBytes')).toBe(64 * 1024 * 1024);
    expect(getLimit(DEFAULT_PLUGIN_LIMITS, 'overlays.maxShapes')).toBe(32);
    expect(getLimit(DEFAULT_PLUGIN_LIMITS, 'does.not.exist')).toBeUndefined();
  });

  it('merges overrides over defaults', () => {
    const merged = mergeLimits({ overlays: { ...DEFAULT_PLUGIN_LIMITS.overlays, maxShapes: 8 } });
    expect(merged.overlays.maxShapes).toBe(8);
    expect(merged.workers.maxInstances).toBe(DEFAULT_PLUGIN_LIMITS.workers.maxInstances);
  });
});

describe('protocol envelopes', () => {
  it('parses valid rpc envelopes', () => {
    const envelope = parseEnvelope({
      kind: 'rpc.request',
      id: 'r1',
      instanceId: 'i1',
      method: 'storage.get',
      params: { key: 'a' },
      deadline: null,
    });
    expect(envelope?.kind).toBe('rpc.request');
  });

  it('rejects malformed and unknown kinds', () => {
    expect(parseEnvelope({ kind: 'rpc.request' })).toBeNull();
    expect(parseEnvelope({ kind: 'totally-new' })).toBeNull();
    expect(parseEnvelope('not-an-object')).toBeNull();
    expect(parseEnvelope(null)).toBeNull();
  });

  it('parses stream chunk envelopes carrying ArrayBuffers', () => {
    const envelope = parseEnvelope({
      kind: 'stream.chunk',
      streamId: 's1',
      seq: 3,
      buffer: new ArrayBuffer(4),
    });
    expect(envelope?.kind).toBe('stream.chunk');
  });

  it('enforces the envelope size budget', () => {
    const huge = {
      kind: 'rpc.request' as const,
      id: 'r1',
      instanceId: 'i1',
      method: 'x',
      params: 'y'.repeat(MAX_ENVELOPE_BYTES + 1),
      deadline: null,
    };
    expect(envelopeFitsBudget(huge, MAX_ENVELOPE_BYTES)).toBe(false);
  });
});

describe('KernelSession RPC', () => {
  it('routes a request and returns a result', async () => {
    const pair = createSessionPair();
    pair.host.handle('math.add', ({ params }) => {
      const record = params as { a: number; b: number };
      return record.a + record.b;
    });
    const result = await pair.plugin.call('math.add', { a: 2, b: 3 });
    expect(result).toBe(5);
    pair.dispose();
  });

  it('rejects with a kernel error when the handler throws', async () => {
    const pair = createSessionPair();
    pair.host.handle('fail', () => {
      throw new KernelError(KernelErrorCode.CAPABILITY_DENIED, {
        details: { capability: 'storage.user' },
      });
    });
    await expect(pair.plugin.call('fail', {})).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    pair.dispose();
  });

  it('answers unknown methods with PROTOCOL_UNSUPPORTED', async () => {
    const pair = createSessionPair();
    await expect(pair.plugin.call('nope', {})).rejects.toMatchObject({
      code: 'PROTOCOL_UNSUPPORTED',
    });
    pair.dispose();
  });

  it('rejects after a local deadline (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const pair = createSessionPair();
      const release = Promise.withResolvers<void>();
      pair.host.handle('slow', async () => {
        await release.promise;
        return 'late';
      });
      const call = pair.plugin.call('slow', {}, { deadlineMs: 20 });
      // Attach the rejection handler before ticking so the rejection is
      // observed at the moment it happens.
      const expectation = expect(call).rejects.toMatchObject({ code: 'OPERATION_DEADLINE' });
      await vi.advanceTimersByTimeAsync(25);
      await expectation;
      release.resolve();
      pair.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates cancellation to the handler signal', async () => {
    const pair = createSessionPair();
    const observedAbort = Promise.withResolvers<boolean>();
    const unblocked = Promise.withResolvers<void>();
    pair.host.handle('cancellable', async ({ signal }) => {
      signal.addEventListener(
        'abort',
        () => {
          observedAbort.resolve(true);
          unblocked.resolve();
        },
        { once: true },
      );
      await unblocked.promise;
      throw new KernelError(KernelErrorCode.OPERATION_ABORTED);
    });
    const controller = new AbortController();
    const call = pair.plugin.call('cancellable', {}, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(await observedAbort.promise).toBe(true);
    pair.dispose();
  });
});

describe('KernelSession byte streams', () => {
  it('streams chunks and ends cleanly', async () => {
    const pair = createSessionPair();
    const collected = Promise.withResolvers<Uint8Array>();
    pair.plugin.onInboundStream((streamId, meta) => {
      expect(meta['purpose']).toBe('test');
      const stream = pair.plugin.getInboundStream(streamId);
      void stream?.collect().then(collected.resolve, collected.reject);
    });

    const writer = pair.host.openOutboundStream({ purpose: 'test' });
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.write(new Uint8Array([4, 5]));
    writer.end();

    expect(Array.from(await collected.promise)).toEqual([1, 2, 3, 4, 5]);
    pair.dispose();
  });

  it('surfaces a producer failure to the consumer', async () => {
    const pair = createSessionPair();
    const failed = Promise.withResolvers<unknown>();
    pair.plugin.onInboundStream((streamId) => {
      const stream = pair.plugin.getInboundStream(streamId);
      void stream?.collect().then(
        () => failed.resolve(new Error('expected failure')),
        (reason) => failed.resolve(reason),
      );
    });

    const writer = pair.host.openOutboundStream({});
    await writer.write(new Uint8Array([9]));
    writer.fail(new KernelError(KernelErrorCode.STREAM_FAILED, { details: { reason: 'boom' } }));

    const reason = await failed.promise;
    expect((reason as KernelError).code).toBe('STREAM_FAILED');
    pair.dispose();
  });

  it('rejects chunks larger than the in-flight window', async () => {
    const pair = createSessionPair();
    const writer = pair.host.openOutboundStream({});
    const huge = new Uint8Array(pair.host.limits.maxInFlightBytes + 1);
    await expect(writer.write(huge)).rejects.toMatchObject({ code: 'PLUGIN_QUOTA_EXCEEDED' });
    pair.dispose();
  });
});

describe('KernelSession events', () => {
  it('delivers evt.emit envelopes to the peer listener with meta', async () => {
    const pair = createSessionPair();
    const received = Promise.withResolvers<{
      event: string;
      payload: unknown;
      meta: { eventId: string; cursor?: string };
    }>();
    pair.plugin.onEvent((event, payload, meta) => {
      received.resolve({ event, payload, meta });
    });

    pair.host.emitEvent('chat.message.created', { messageId: 'm1' }, 'cursor-42');
    const result = await received.promise;
    expect(result.event).toBe('chat.message.created');
    expect(result.payload).toEqual({ messageId: 'm1' });
    expect(result.meta.cursor).toBe('cursor-42');
    expect(result.meta.eventId.length).toBeGreaterThan(0);
    pair.dispose();
  });

  it('omits the cursor when not provided', async () => {
    const pair = createSessionPair();
    const received = Promise.withResolvers<{ eventId: string; cursor?: string }>();
    pair.plugin.onEvent((_event, _payload, meta) => received.resolve(meta));

    pair.host.emitEvent('chat.opened', {});
    expect((await received.promise).cursor).toBeUndefined();
    pair.dispose();
  });

  it('works in both directions and supports unsubscribe', async () => {
    const pair = createSessionPair();
    const hostSeen: string[] = [];
    pair.host.onEvent((event) => {
      hostSeen.push(event);
    });

    const pluginSeen: string[] = [];
    const unsubscribe = pair.plugin.onEvent((event) => {
      pluginSeen.push(event);
    });

    pair.plugin.emitEvent('plugin.job.due', { jobId: 'j1' });
    pair.host.emitEvent('chat.opened', {});
    await Promise.resolve();
    expect(hostSeen).toEqual(['plugin.job.due']);
    expect(pluginSeen).toEqual(['chat.opened']);

    unsubscribe();
    pair.host.emitEvent('chat.opened', {});
    await Promise.resolve();
    expect(pluginSeen).toHaveLength(1);
    pair.dispose();
  });

  it('isolates listener exceptions from the session and other listeners', async () => {
    const pair = createSessionPair();
    const seen: string[] = [];
    pair.plugin.onEvent(() => {
      throw new Error('listener boom');
    });
    pair.plugin.onEvent((event) => {
      seen.push(event);
    });

    pair.host.emitEvent('chat.opened', {});
    await Promise.resolve();
    expect(seen).toEqual(['chat.opened']);
    pair.dispose();
  });
});
