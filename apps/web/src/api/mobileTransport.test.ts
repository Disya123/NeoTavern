/**
 * MobileBridgeTransport tests: handshake contract check, envelope building,
 * product vs transport error split, stream events/terminal/error, durable
 * cancel, and the callback-install ordering guarantee (ТЗ §7.2 Phase 5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductError, TransportError } from '@neotavern/client-sdk';
import { WIRE_PROTOCOL, WIRE_SCHEMA_HASH } from '@neotavern/contracts';
import { ContractMismatchError } from '@neotavern/neobackend';
import { MobileBridgeTransport, type MobileBridgeLike } from './mobileTransport.js';

const FIXED_REQUEST_ID = '00000000-0000-4000-8000-000000000001';

/** Minimal host-bridge stand-in: records calls, can deliver/reject. */
class FakeBridge implements MobileBridgeLike {
  readonly calls: Array<{ requestId: string; envelopeJson: string; callbackId: string }> = [];
  readonly cancels: string[] = [];
  handshakeResult: string;
  onCall?: (requestId: string, envelopeJson: string, callbackId: string) => void;

  constructor(handshake?: string) {
    this.handshakeResult =
      handshake ??
      JSON.stringify({
        ffiAbiVersion: 1,
        schemaHash: WIRE_SCHEMA_HASH,
        wireProtocol: { major: WIRE_PROTOCOL.major, minor: WIRE_PROTOCOL.minor },
        appVersion: '0.1.0',
      });
  }

  handshake(): string {
    return this.handshakeResult;
  }

  call(requestId: string, envelopeJson: string, callbackId: string): void {
    this.calls.push({ requestId, envelopeJson, callbackId });
    this.onCall?.(requestId, envelopeJson, callbackId);
  }

  cancelStream(streamId: string): void {
    this.cancels.push(streamId);
  }

  /** Deliver a resolved callback payload exactly as the host would. */
  deliver(callbackId: string, envelope: unknown): void {
    const surface = (
      window as unknown as {
        __neotavernMobileCallbacks?: { resolve: (id: string, value: unknown) => void };
      }
    ).__neotavernMobileCallbacks;
    if (surface === undefined) throw new Error('callback surface not installed');
    surface.resolve(callbackId, envelope);
  }

  /** Deliver a rejected callback exactly as the host would. */
  reject(callbackId: string, error: unknown): void {
    const surface = (
      window as unknown as {
        __neotavernMobileCallbacks?: { reject: (id: string, value: unknown) => void };
      }
    ).__neotavernMobileCallbacks;
    if (surface === undefined) throw new Error('callback surface not installed');
    surface.reject(callbackId, error);
  }
}

function makeTransport(overrides?: {
  bridge?: FakeBridge;
  requestId?: () => string;
  callTimeoutMs?: number;
}) {
  const bridge = overrides?.bridge ?? new FakeBridge();
  vi.stubGlobal('__neotavernMobile', bridge);
  const transport = new MobileBridgeTransport({
    requestId: overrides?.requestId ?? (() => FIXED_REQUEST_ID),
    callTimeoutMs: overrides?.callTimeoutMs,
  });
  return { transport, bridge };
}

function okEnvelope(result: unknown): object {
  return { kind: 'ok', requestId: FIXED_REQUEST_ID, result };
}

function errorEnvelope(code: string): object {
  return { kind: 'error', requestId: FIXED_REQUEST_ID, error: { code, params: {} } };
}

const tick = (): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (window as unknown as { __neotavernMobileCallbacks?: unknown }).__neotavernMobileCallbacks;
});

describe('handshake', () => {
  it('throws ContractMismatchError when the bridge schema hash differs', async () => {
    const bridge = new FakeBridge(
      JSON.stringify({
        ffiAbiVersion: 1,
        schemaHash: 'deadbeef',
        wireProtocol: { major: 1, minor: 0 },
        appVersion: '0.1.0',
      }),
    );
    const { transport } = makeTransport({ bridge });
    await expect(transport.call('meta.get', {}, {})).rejects.toBeInstanceOf(ContractMismatchError);
  });

  it('throws a typed transport error when no bridge is present', async () => {
    const transport = new MobileBridgeTransport();
    await expect(transport.call('meta.get', {}, {})).rejects.toBeInstanceOf(TransportError);
  });
});

describe('call', () => {
  it('installs the callback surface before invoking the bridge', async () => {
    const bridge = new FakeBridge();
    let surfaceAtCallTime: unknown = 'not installed yet';
    bridge.onCall = () => {
      surfaceAtCallTime = (window as unknown as { __neotavernMobileCallbacks?: unknown })
        .__neotavernMobileCallbacks;
    };
    const { transport } = makeTransport({ bridge });
    void transport.call('meta.get', {}, {}).catch(() => undefined);
    await tick();
    expect(surfaceAtCallTime).toMatchObject({
      resolve: expect.any(Function),
      reject: expect.any(Function),
    });
  });

  it('builds a contract envelope and returns the ok result', async () => {
    const bridge = new FakeBridge();
    const { transport } = makeTransport({ bridge });
    const resultPromise = transport.call('characters.get', { characterId: 'c1' }, {});
    await tick();

    const firstCall = bridge.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) throw new Error('bridge.call was not invoked');
    expect(firstCall.requestId).toBe(FIXED_REQUEST_ID);
    const envelope = JSON.parse(firstCall.envelopeJson) as {
      wireProtocol: { major: number; minor: number };
      schemaHash: string;
      requestId: string;
      operationId: string;
      payload: unknown;
    };
    expect(envelope.wireProtocol).toEqual({
      major: WIRE_PROTOCOL.major,
      minor: WIRE_PROTOCOL.minor,
    });
    expect(envelope.schemaHash).toBe(WIRE_SCHEMA_HASH);
    expect(envelope.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(envelope.operationId).toBe('characters.get');
    expect(envelope.payload).toEqual({ characterId: 'c1' });

    bridge.deliver(firstCall.callbackId, okEnvelope({ id: 'c1' }));
    await expect(resultPromise).resolves.toEqual({ ok: true, value: { id: 'c1' } });
  });

  it('returns product errors without throwing', async () => {
    const bridge = new FakeBridge();
    const { transport } = makeTransport({ bridge });
    const resultPromise = transport.call('characters.get', { characterId: 'nope' }, {});
    await tick();
    const firstCall = bridge.calls[0];
    if (firstCall === undefined) throw new Error('bridge.call was not invoked');
    bridge.deliver(firstCall.callbackId, errorEnvelope('CHARACTER_NOT_FOUND'));

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CHARACTER_NOT_FOUND');
    }
  });

  it('throws a typed transport error on bridge reject', async () => {
    const bridge = new FakeBridge();
    const { transport } = makeTransport({ bridge });
    const resultPromise = transport.call('meta.get', {}, {});
    await tick();
    const firstCall = bridge.calls[0];
    if (firstCall === undefined) throw new Error('bridge.call was not invoked');
    bridge.reject(firstCall.callbackId, { message: 'bridge exploded' });
    await expect(resultPromise).rejects.toBeInstanceOf(TransportError);
  });

  it('throws a typed transport error when the callback times out', async () => {
    vi.useFakeTimers();
    try {
      const bridge = new FakeBridge();
      const { transport } = makeTransport({ bridge, callTimeoutMs: 1000 });
      const resultPromise = transport.call('meta.get', {}, {});
      // Attach the rejection handler before the timer fires so the runner
      // never observes the rejection as unhandled.
      const assertion = expect(resultPromise).rejects.toBeInstanceOf(TransportError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a typed transport error when the response does not echo the request id', async () => {
    const bridge = new FakeBridge();
    const { transport } = makeTransport({ bridge });
    const resultPromise = transport.call('meta.get', {}, {});
    await tick();
    const firstCall = bridge.calls[0];
    if (firstCall === undefined) throw new Error('bridge.call was not invoked');
    bridge.deliver(firstCall.callbackId, {
      kind: 'ok',
      requestId: '99999999-9999-4999-8999-999999999999',
      result: {},
    });
    await expect(resultPromise).rejects.toBeInstanceOf(TransportError);
  });
});

describe('stream', () => {
  it('yields committed events and ends on the terminal payload', async () => {
    const bridge = new FakeBridge();
    const { transport } = makeTransport({ bridge });
    const iterator = transport.stream('generation.start', { chatId: 'c1' }, {});
    const next = iterator[Symbol.asyncIterator]().next();

    await tick();
    const firstCall = bridge.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) throw new Error('bridge.call was not invoked');
    expect((JSON.parse(firstCall.envelopeJson) as { operationId: string }).operationId).toBe(
      'generation.start',
    );
    const callbackId = firstCall.callbackId;

    bridge.deliver(callbackId, {
      kind: 'event',
      event: {
        streamId: 's1',
        sequence: 0,
        type: 'generation.delta',
        payload: { type: 'generation.delta', text: 'Hi' },
      },
    });
    bridge.deliver(callbackId, {
      kind: 'event',
      event: {
        streamId: 's1',
        sequence: 1,
        type: 'generation.completed',
        payload: { type: 'generation.completed', finalMessage: { id: 'm1' } },
      },
    });
    bridge.deliver(callbackId, { kind: 'terminal' });

    const first = await next;
    expect(first.done).toBe(false);
    if (first.done) throw new Error('stream ended before the first event');
    expect(first.value).toMatchObject({ streamId: 's1', sequence: 0, type: 'generation.delta' });
    expect(first.value.payload).toEqual({ type: 'generation.delta', text: 'Hi' });

    const second = await iterator[Symbol.asyncIterator]().next();
    expect(second.done).toBe(false);
    if (second.done) throw new Error('stream ended before the terminal event');
    expect(second.value.type).toBe('generation.completed');

    const third = await iterator[Symbol.asyncIterator]().next();
    expect(third.done).toBe(true);
  });

  it('throws a product error when the stream delivers an error payload', async () => {
    const bridge = new FakeBridge();
    const { transport } = makeTransport({ bridge });
    const iterator = transport.stream('generation.start', { chatId: 'nope' }, {});
    const next = iterator[Symbol.asyncIterator]().next();
    await tick();
    const firstCall = bridge.calls[0];
    if (firstCall === undefined) throw new Error('bridge.call was not invoked');
    bridge.deliver(firstCall.callbackId, {
      kind: 'error',
      error: { code: 'CHAT_NOT_FOUND', params: {} },
    });
    await expect(next).rejects.toBeInstanceOf(ProductError);
  });

  it('throws a typed transport error when the stream is rejected', async () => {
    const bridge = new FakeBridge();
    const { transport } = makeTransport({ bridge });
    const iterator = transport.stream('generation.start', { chatId: 'c1' }, {});
    const next = iterator[Symbol.asyncIterator]().next();
    await tick();
    const firstCall = bridge.calls[0];
    if (firstCall === undefined) throw new Error('bridge.call was not invoked');
    bridge.reject(firstCall.callbackId, { message: 'session state invalid' });
    await expect(next).rejects.toBeInstanceOf(TransportError);
  });

  it('requests a durable cancel when the consumer returns early', async () => {
    const bridge = new FakeBridge();
    const { transport } = makeTransport({ bridge });
    const iterator = transport.stream('generation.start', { chatId: 'c1' }, {});
    // Start consuming so the stream actually opens, then learn the stream id
    // from the first event and leave before it ends: the return must cancel
    // the opened run durably.
    void iterator[Symbol.asyncIterator]().next();
    await tick();
    const firstCall = bridge.calls[0];
    if (firstCall === undefined) throw new Error('bridge.call was not invoked');
    bridge.deliver(firstCall.callbackId, {
      kind: 'event',
      event: {
        streamId: 's1',
        sequence: 0,
        type: 'generation.delta',
        payload: { type: 'generation.delta', text: 'x' },
      },
    });
    await iterator[Symbol.asyncIterator]().return!();

    expect(bridge.cancels).toEqual(['s1']);
  });

  it('cancels with the first event stream id when the consumer left before it arrived', async () => {
    const bridge = new FakeBridge();
    const { transport } = makeTransport({ bridge });
    const iterator = transport.stream('generation.start', { chatId: 'c1' }, {});
    void iterator[Symbol.asyncIterator]().next();
    // Leave before the open completes (no event yet): the eager open survives
    // and cancels as soon as the first event reveals the stream id.
    await iterator[Symbol.asyncIterator]().return!();
    await tick();
    const firstCall = bridge.calls[0];
    if (firstCall === undefined) throw new Error('bridge.call was not invoked');
    bridge.deliver(firstCall.callbackId, {
      kind: 'event',
      event: {
        streamId: 's9',
        sequence: 0,
        type: 'generation.delta',
        payload: { type: 'generation.delta', text: 'x' },
      },
    });
    await tick();

    expect(bridge.cancels).toEqual(['s9']);
  });
});
