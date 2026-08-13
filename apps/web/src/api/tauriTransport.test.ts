/**
 * TauriTransport tests: envelope building, product vs transport error split,
 * stream open/events/end, and abort semantics (ТЗ §11.1/§15.1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductError, TransportError } from '@neotavern/client-sdk';
import { WIRE_PROTOCOL, WIRE_SCHEMA_HASH } from '@neotavern/contracts';
import { TauriTransport, type TauriChannelLike } from './tauriTransport.js';
import { isTauriRuntime } from './tauriTransport.js';

/** Minimal Channel stand-in: captures `onmessage`, can emit from tests. */
class FakeChannel implements TauriChannelLike {
  onmessage: ((message: unknown) => void) | undefined;
  emit(message: unknown): void {
    this.onmessage?.(message);
  }
}

/** Transport subclass that records every channel it creates. */
class RecordingTransport extends TauriTransport {
  readonly channels: FakeChannel[] = [];
  protected override createChannel(): TauriChannelLike {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }
}

interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

function makeTransport(overrides?: {
  responses?: Array<unknown | Error>;
  onInvoke?: (call: InvokeCall) => void;
  requestId?: () => string;
}) {
  const calls: InvokeCall[] = [];
  const invokeImpl = (async (command: string, args: Record<string, unknown>) => {
    const call: InvokeCall = { command, args };
    calls.push(call);
    overrides?.onInvoke?.(call);
    const response = overrides?.responses?.shift();
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as (command: string, args?: unknown) => Promise<unknown>;

  const transport = new RecordingTransport({
    invoke: invokeImpl as never,
    requestId: overrides?.requestId ?? (() => '00000000-0000-4000-8000-000000000001'),
  });
  return { transport, calls };
}

function okEnvelope(result: unknown): string {
  return JSON.stringify({ kind: 'ok', requestId: '00000000-0000-4000-8000-000000000001', result });
}

function errorEnvelope(code: string): string {
  return JSON.stringify({
    kind: 'error',
    requestId: '00000000-0000-4000-8000-000000000001',
    error: { code, params: {} },
  });
}

const tick = (): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

/** Fails the test when the stream never created its channel. */
function requireChannel(transport: RecordingTransport): FakeChannel {
  const channel = transport.channels[0];
  if (channel === undefined) throw new Error('stream did not create a channel');
  return channel;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isTauriRuntime', () => {
  it('detects the Tauri bridge when present', () => {
    expect(isTauriRuntime()).toBe(false);
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    expect(isTauriRuntime()).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('call', () => {
  it('builds a contract envelope and returns the ok result', async () => {
    const { transport, calls } = makeTransport({ responses: [okEnvelope({ id: 'c1' })] });
    const result = await transport.call('characters.get', { characterId: 'c1' }, {});
    expect(result).toEqual({ ok: true, value: { id: 'c1' } });

    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) throw new Error('kernel_dispatch was not invoked');
    expect(firstCall.command).toBe('kernel_dispatch');
    const envelope = JSON.parse(String(firstCall.args.envelope)) as {
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
  });

  it('returns product errors without throwing', async () => {
    const { transport } = makeTransport({ responses: [errorEnvelope('CHARACTER_NOT_FOUND')] });
    const result = await transport.call('characters.get', { characterId: 'nope' }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CHARACTER_NOT_FOUND');
    }
  });

  it('throws a typed transport error on invoke rejection', async () => {
    const { transport } = makeTransport({ responses: [new Error('ipc broken')] });
    await expect(transport.call('meta.get', {}, {})).rejects.toBeInstanceOf(TransportError);
  });

  it('throws a typed transport error on non-JSON responses', async () => {
    const { transport } = makeTransport({ responses: ['not json'] });
    await expect(transport.call('meta.get', {}, {})).rejects.toBeInstanceOf(TransportError);
  });
});

describe('stream', () => {
  it('yields committed events and ends on the null sentinel', async () => {
    const { transport } = makeTransport({ responses: [okEnvelope({ streamId: 's1' })] });
    const iterator = transport.stream('generation.start', { chatId: 'c1' }, {});
    const next = iterator[Symbol.asyncIterator]().next();

    await tick();
    const channel = requireChannel(transport);
    channel.emit({
      streamId: 's1',
      sequence: 0,
      type: 'generation.delta',
      payload: { type: 'generation.delta', text: 'Hi' },
    });
    channel.emit({
      streamId: 's1',
      sequence: 1,
      type: 'generation.completed',
      payload: { type: 'generation.completed', finalMessage: { id: 'm1' } },
    });
    channel.emit(null);

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

  it('throws a product error when the open response is an error envelope', async () => {
    const { transport } = makeTransport({ responses: [errorEnvelope('CHAT_NOT_FOUND')] });
    const iterator = transport.stream('generation.start', { chatId: 'nope' }, {});
    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ProductError);
  });

  it('requests a durable abort when the consumer leaves early', async () => {
    const { transport, calls } = makeTransport({ responses: [okEnvelope({ streamId: 's1' })] });
    const iterator = transport.stream('generation.start', { chatId: 'c1' }, {});
    // Start consuming so the stream actually opens (the pending `next` never
    // resolves without events), then leave before any event arrives: the
    // finally must cancel the opened run durably.
    void iterator[Symbol.asyncIterator]().next();
    await tick();
    await iterator[Symbol.asyncIterator]().return!();

    const abort = calls.find((call) => call.command === 'kernel_stream_abort');
    expect(abort?.args).toEqual({ streamId: 's1' });
  });

  it('aborts with the event stream id when the open result has none', async () => {
    const { transport, calls } = makeTransport({ responses: [okEnvelope({})] });
    const iterator = transport.stream('generation.start', { chatId: 'c1' }, {});
    const next = iterator[Symbol.asyncIterator]().next();
    await tick();
    requireChannel(transport).emit({
      streamId: 's9',
      sequence: 0,
      type: 'generation.delta',
      payload: { type: 'generation.delta', text: 'x' },
    });
    await next;
    await iterator[Symbol.asyncIterator]().return!();

    const abort = calls.find((call) => call.command === 'kernel_stream_abort');
    expect(abort?.args).toEqual({ streamId: 's9' });
  });
});
