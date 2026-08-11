/**
 * Rev4 kernel events slice (web host side): allowlist, chat-content
 * capability gate, app-event relay, and the §J1 cursor/replay/ack protocol
 * (at-least-once recovery, bounded in-flight backpressure, expired-cursor
 * rejection).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import { attachEvents } from './events.js';
import type { KernelHostContext } from './types.js';

const { KernelErrorCode } = kernel;

interface FakeRecord {
  seq: number;
  ts: number;
  payload: unknown;
}

function fakeContext(capabilities: ReadonlySet<string>) {
  const handlers = new Map<string, (ctx: { params: unknown }) => unknown>();
  const tracked: Array<{ dispose: () => void }> = [];
  const relays: Array<{ event: string; listener: (payload: unknown) => void }> = [];
  const emitted: Array<{ event: string; payload: unknown; cursor?: string }> = [];
  /** Per-event replay buffer mirroring the runtime ring buffer. */
  const history = new Map<string, FakeRecord[]>();
  const seqByEvent = new Map<string, number>();
  const session = {
    handle: vi.fn((method: string, handler: (ctx: { params: unknown }) => unknown) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    emitEvent: vi.fn((event: string, payload: unknown, cursor?: string) => {
      emitted.push({ event, payload, cursor });
    }),
    scope: {
      track: vi.fn((item: { dispose: () => void }) => {
        tracked.push(item);
        return item;
      }),
    },
  };
  const runtime = {
    onAppEvent: vi.fn((event: string, listener: (payload: unknown) => void) => {
      relays.push({ event, listener });
      return () => {
        const index = relays.findIndex((entry) => entry.listener === listener);
        if (index >= 0) relays.splice(index, 1);
      };
    }),
    kernelAppEventHistoryAfter: vi.fn((event: string, afterSeq: number) => {
      const records = history.get(event) ?? [];
      return {
        records: records.filter((record) => record.seq > afterSeq),
        lowestSeq: records.length > 0 ? (records[0]?.seq ?? 0) : null,
        headSeq: records.length > 0 ? (records[records.length - 1]?.seq ?? 0) : null,
      };
    }),
  };
  const ctx = {
    pluginId: 'test.events',
    frame: {},
    session,
    runtime,
    hasCapability: (name: string) => capabilities.has(name),
    currentChatId: () => null,
  } as unknown as KernelHostContext;

  /** Record an app event and deliver it to relay listeners (as the runtime
   *  does: history first, then listeners). */
  const emitAppEvent = (event: string, payload: unknown): void => {
    const seq = (seqByEvent.get(event) ?? 0) + 1;
    seqByEvent.set(event, seq);
    const records = history.get(event) ?? [];
    records.push({ seq, ts: Date.now(), payload });
    history.set(event, records);
    for (const entry of relays) {
      if (entry.event === event) entry.listener(payload);
    }
  };
  return { ctx, handlers, session, runtime, tracked, relays, emitted, emitAppEvent, history };
}

function invoke(
  handlers: Map<string, (ctx: { params: unknown }) => unknown>,
  method: string,
  params: unknown,
) {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`no handler for ${method}`);
  return handler({ params });
}

/** Wrap a possibly-synchronous handler invocation in a promise. */
function invokeAsync(
  handlers: Map<string, (ctx: { params: unknown }) => unknown>,
  method: string,
  params: unknown,
) {
  return Promise.resolve().then(() => invoke(handlers, method, params));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kernel events', () => {
  it('registers events wire methods and no relays upfront', () => {
    const fake = fakeContext(new Set());
    attachEvents(fake.ctx);
    expect([...fake.handlers.keys()].sort()).toEqual([
      'events.ack',
      'events.subscribe',
      'events.unsubscribe',
    ]);
    expect(fake.relays).toHaveLength(0);
    expect(fake.tracked).toHaveLength(0);
  });

  it('subscribes to an allowed event and relays app payloads to the session', async () => {
    const fake = fakeContext(new Set());
    attachEvents(fake.ctx);
    await invokeAsync(fake.handlers, 'events.subscribe', { event: 'chat.opened' });
    expect(fake.relays).toHaveLength(1);
    expect(fake.relays[0]?.event).toBe('chat.opened');
    expect(fake.tracked).toHaveLength(1);

    fake.emitAppEvent('chat.opened', { chatId: 'c1' });
    expect(fake.emitted).toEqual([
      { event: 'chat.opened', payload: { chatId: 'c1' }, cursor: 'chat.opened:1' },
    ]);
  });

  it('rejects empty, oversized and unknown event names', async () => {
    const fake = fakeContext(new Set());
    attachEvents(fake.ctx);
    await expect(
      invokeAsync(fake.handlers, 'events.subscribe', { event: '' }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }));
    await expect(
      invokeAsync(fake.handlers, 'events.subscribe', { event: 'x'.repeat(201) }),
    ).rejects.toThrowError(expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }));
    await expect(
      invokeAsync(fake.handlers, 'events.subscribe', { event: 'custom.wildcard' }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: KernelErrorCode.VALIDATION_FAILED,
        details: expect.objectContaining({ reason: 'event-not-allowed' }),
      }),
    );
    expect(fake.relays).toHaveLength(0);
  });

  it('requires chats.read.current for chat-content events', async () => {
    const denied = fakeContext(new Set());
    attachEvents(denied.ctx);
    await expect(
      invokeAsync(denied.handlers, 'events.subscribe', { event: 'chat.message.created' }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: KernelErrorCode.CAPABILITY_DENIED,
        details: expect.objectContaining({ capability: 'chats.read.current' }),
      }),
    );
    expect(denied.relays).toHaveLength(0);

    const granted = fakeContext(new Set(['chats.read.current']));
    attachEvents(granted.ctx);
    await invokeAsync(granted.handlers, 'events.subscribe', { event: 'chat.message.created' });
    expect(granted.relays).toHaveLength(1);
  });

  it('drops chat-content events at emit time once the grant is gone', async () => {
    let granted = true;
    const capabilities = new Set<string>(['chats.read.current']);
    const fake = fakeContext(capabilities);
    fake.ctx.hasCapability = vi.fn((name: string) => name === 'chats.read.current' && granted);
    attachEvents(fake.ctx);
    await invokeAsync(fake.handlers, 'events.subscribe', { event: 'generation.delta' });

    fake.emitAppEvent('generation.delta', { token: 'a' });
    expect(fake.emitted).toEqual([
      { event: 'generation.delta', payload: { token: 'a' }, cursor: 'generation.delta:1' },
    ]);

    granted = false;
    fake.emitAppEvent('generation.delta', { token: 'b' });
    expect(fake.emitted).toHaveLength(1);
  });

  describe('cursor replay and backpressure (rev4 §J1)', () => {
    it('replays retained events after the cursor, then continues live', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      fake.emitAppEvent('chat.opened', { chatId: 'c0' });
      fake.emitAppEvent('chat.opened', { chatId: 'c1' });
      fake.emitAppEvent('chat.opened', { chatId: 'c2' });

      await invokeAsync(fake.handlers, 'events.subscribe', {
        event: 'chat.opened',
        cursor: 'chat.opened:1',
      });
      expect(fake.emitted.map((entry) => entry.payload)).toEqual([
        { chatId: 'c1' },
        { chatId: 'c2' },
      ]);
      expect(fake.emitted.map((entry) => entry.cursor)).toEqual(['chat.opened:2', 'chat.opened:3']);

      fake.emitAppEvent('chat.opened', { chatId: 'c3' });
      expect(fake.emitted).toHaveLength(3);
      expect(fake.emitted[2]).toEqual({
        event: 'chat.opened',
        payload: { chatId: 'c3' },
        cursor: 'chat.opened:4',
      });
    });

    it('fresh subscriptions start at the head: no replay of the past', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      fake.emitAppEvent('chat.opened', { chatId: 'old' });
      fake.emitAppEvent('chat.opened', { chatId: 'older' });

      await invokeAsync(fake.handlers, 'events.subscribe', { event: 'chat.opened' });
      expect(fake.emitted).toHaveLength(0);
      fake.emitAppEvent('chat.opened', { chatId: 'now' });
      expect(fake.emitted).toHaveLength(1);
    });

    it('rejects malformed, cross-event and future cursors', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      fake.emitAppEvent('chat.opened', { chatId: 'c1' });
      for (const bad of ['not-a-cursor', 'chat.message.deleted:1', 'chat.opened:abc', 42]) {
        await expect(
          invokeAsync(fake.handlers, 'events.subscribe', { event: 'chat.opened', cursor: bad }),
        ).rejects.toThrowError(
          expect.objectContaining({
            code: KernelErrorCode.VALIDATION_FAILED,
            details: expect.objectContaining({ reason: 'invalid-cursor' }),
          }),
        );
      }
      await expect(
        invokeAsync(fake.handlers, 'events.subscribe', {
          event: 'chat.opened',
          cursor: 'chat.opened:99',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: KernelErrorCode.VALIDATION_FAILED,
          details: expect.objectContaining({ reason: 'future-cursor' }),
        }),
      );
    });

    it('rejects cursors outside the retained replay window', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      // The ring buffer only retains the recent tail (records 5..7); the
      // cursor points before it — the replay window is gone.
      for (let seq = 1; seq <= 7; seq += 1) {
        fake.emitAppEvent('chat.opened', { chatId: `c${seq}` });
      }
      const records = fake.history.get('chat.opened') ?? [];
      records.splice(0, 4); // evict seq 1..4 like the runtime trim does
      fake.history.set('chat.opened', records);

      await expect(
        invokeAsync(fake.handlers, 'events.subscribe', {
          event: 'chat.opened',
          cursor: 'chat.opened:2',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: KernelErrorCode.EVENT_CURSOR_EXPIRED,
          details: expect.objectContaining({ reason: 'cursor-expired', retainedFrom: 5 }),
        }),
      );
      // Cursor at the window edge replays everything retained.
      await invokeAsync(fake.handlers, 'events.subscribe', {
        event: 'chat.opened',
        cursor: 'chat.opened:4',
      });
      expect(fake.emitted.map((entry) => entry.cursor)).toEqual([
        'chat.opened:5',
        'chat.opened:6',
        'chat.opened:7',
      ]);
    });

    it('pauses delivery at maxInFlight and resumes on ack', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      for (let seq = 1; seq <= 5; seq += 1) {
        fake.emitAppEvent('chat.opened', { chatId: `c${seq}` });
      }
      await invokeAsync(fake.handlers, 'events.subscribe', {
        event: 'chat.opened',
        cursor: 'chat.opened:0',
        maxInFlight: 2,
      });
      expect(fake.emitted).toHaveLength(2);

      // No more deliveries while two are unacked.
      fake.emitAppEvent('chat.opened', { chatId: 'c6' });
      expect(fake.emitted).toHaveLength(2);

      await invokeAsync(fake.handlers, 'events.ack', { event: 'chat.opened', sequence: 1 });
      expect(fake.emitted).toHaveLength(3);
      expect(fake.emitted[2]?.payload).toEqual({ chatId: 'c3' });

      await invokeAsync(fake.handlers, 'events.ack', { event: 'chat.opened', sequence: 2 });
      expect(fake.emitted).toHaveLength(4);
      expect(fake.emitted[3]?.payload).toEqual({ chatId: 'c4' });
    });

    it('acks are idempotent and unknown acks are ignored', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      fake.emitAppEvent('chat.opened', { chatId: 'c1' });
      await invokeAsync(fake.handlers, 'events.subscribe', {
        event: 'chat.opened',
        cursor: 'chat.opened:0',
      });
      expect(fake.emitted).toHaveLength(1);

      await invokeAsync(fake.handlers, 'events.ack', { event: 'chat.opened', sequence: 1 });
      await invokeAsync(fake.handlers, 'events.ack', { event: 'chat.opened', sequence: 1 });
      await invokeAsync(fake.handlers, 'events.ack', { event: 'chat.opened', sequence: 42 });
      await invokeAsync(fake.handlers, 'events.ack', { event: 'other.event', sequence: 1 });
      expect(fake.emitted).toHaveLength(1);
    });

    it('at-least-once: unacked events are re-delivered on resubscribe with the last cursor', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      for (let seq = 1; seq <= 3; seq += 1) {
        fake.emitAppEvent('chat.opened', { chatId: `c${seq}` });
      }
      await invokeAsync(fake.handlers, 'events.subscribe', {
        event: 'chat.opened',
        cursor: 'chat.opened:0',
        maxInFlight: 1,
      });
      expect(fake.emitted).toHaveLength(1);
      // The consumer handled seq 1 but never acked seq 2/3 (session died).
      await invokeAsync(fake.handlers, 'events.unsubscribe', { event: 'chat.opened' });
      expect(fake.relays).toHaveLength(0);

      // Reconnect with the cursor of the last *handled* event.
      await invokeAsync(fake.handlers, 'events.subscribe', {
        event: 'chat.opened',
        cursor: 'chat.opened:1',
      });
      expect(fake.emitted.map((entry) => entry.cursor)).toEqual([
        'chat.opened:1',
        'chat.opened:2',
        'chat.opened:3',
      ]);
    });

    it('resubscribe with cursor resets delivery state and replays the gap', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      fake.emitAppEvent('chat.opened', { chatId: 'c1' });
      await invokeAsync(fake.handlers, 'events.subscribe', { event: 'chat.opened' });
      fake.emitAppEvent('chat.opened', { chatId: 'c2' });
      expect(fake.emitted).toHaveLength(1);

      // The consumer asks to resume from the start of the retained window.
      await invokeAsync(fake.handlers, 'events.subscribe', {
        event: 'chat.opened',
        cursor: 'chat.opened:0',
      });
      expect(fake.emitted.map((entry) => entry.cursor)).toEqual([
        'chat.opened:2',
        'chat.opened:1',
        'chat.opened:2',
      ]);
    });

    it('rejects invalid maxInFlight values', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      for (const bad of [0, -1, 1.5, '4']) {
        await expect(
          invokeAsync(fake.handlers, 'events.subscribe', {
            event: 'chat.opened',
            maxInFlight: bad,
          }),
        ).rejects.toThrowError(
          expect.objectContaining({
            code: KernelErrorCode.VALIDATION_FAILED,
            details: expect.objectContaining({ reason: 'invalid-max-in-flight' }),
          }),
        );
      }
      await invokeAsync(fake.handlers, 'events.subscribe', {
        event: 'chat.opened',
        maxInFlight: 1000,
      });
      expect(fake.relays).toHaveLength(1);
    });

    it('unsubscribe removes the relay and the subscription', async () => {
      const fake = fakeContext(new Set());
      attachEvents(fake.ctx);
      await invokeAsync(fake.handlers, 'events.subscribe', { event: 'chat.opened' });
      expect(fake.relays).toHaveLength(1);
      await invokeAsync(fake.handlers, 'events.unsubscribe', { event: 'chat.opened' });
      expect(fake.relays).toHaveLength(0);
      fake.emitAppEvent('chat.opened', { chatId: 'after' });
      expect(fake.emitted).toHaveLength(0);
    });
  });
});
