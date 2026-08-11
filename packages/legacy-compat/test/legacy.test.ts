import { describe, it, expect } from 'vitest';
import {
  LegacyEventSource,
  event_types,
  islandElementId,
  createLegacyContext,
  setLegacyBridge,
  clearLegacyBridge,
} from '../src/index.js';
import { makeBridge } from './helpers.js';

describe('LegacyEventSource', () => {
  it('emits to subscribers and supports off', () => {
    const source = new LegacyEventSource();
    const received: unknown[] = [];
    const handler = (data?: unknown) => received.push(data);
    source.on(event_types.MESSAGE_RECEIVED, handler);
    source.emit(event_types.MESSAGE_RECEIVED, 'a');
    source.emit(event_types.MESSAGE_RECEIVED, 'b');
    source.off(event_types.MESSAGE_RECEIVED, handler);
    source.emit(event_types.MESSAGE_RECEIVED, 'c');
    expect(received).toEqual(['a', 'b']);
  });

  it('supports once', () => {
    const source = new LegacyEventSource();
    let count = 0;
    source.once('x', () => {
      count += 1;
    });
    source.emit('x');
    source.emit('x');
    expect(count).toBe(1);
  });

  it('isolates a throwing handler', () => {
    const source = new LegacyEventSource();
    const ok: number[] = [];
    source.on('e', () => {
      throw new Error('bad legacy listener');
    });
    source.on('e', () => ok.push(1));
    expect(() => source.emit('e')).not.toThrow();
    expect(ok).toEqual([1]);
  });
});

describe('domIslands', () => {
  it('derives stable element ids', () => {
    expect(islandElementId('legacy.chat.actions')).toBe('legacy-chat-actions');
  });
});

describe('legacy context', () => {
  it('exposes bridge data through getContext-style accessors', () => {
    setLegacyBridge(makeBridge());
    const ctx = createLegacyContext(new LegacyEventSource());
    expect(ctx.characters).toEqual([{ id: 'c1', name: 'Alice' }]);
    expect(ctx.chatId).toBe('chat1');
    expect(ctx.extension_settings).toEqual({ ext: { foo: 1 } });
    expect(ctx.getRequestHeaders()['Content-Type']).toBe('application/json');
    clearLegacyBridge();
  });

  it('falls back to safe defaults without a bridge', () => {
    clearLegacyBridge();
    const ctx = createLegacyContext(new LegacyEventSource());
    expect(ctx.characters).toEqual([]);
    expect(ctx.chatId).toBeNull();
  });
});
