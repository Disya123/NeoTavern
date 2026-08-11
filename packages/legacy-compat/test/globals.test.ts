// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installLegacyCompat, type LegacyCompatHandle } from '../src/globals.js';
import { LegacyEventSource, clearLegacyBridge, event_types } from '../src/index.js';
import { makeBridge } from './helpers.js';

type LegacyWindow = Window & {
  SillyTavern?: {
    getContext(): { eventSource: LegacyEventSource; event_types: typeof event_types };
    eventSource: LegacyEventSource;
    event_types: typeof event_types;
  };
  eventSource?: LegacyEventSource;
  event_types?: typeof event_types;
  extension_settings?: Record<string, Record<string, unknown>>;
  jQuery?: unknown;
  $?: unknown;
};

const win = window as LegacyWindow;

let handle: LegacyCompatHandle | null = null;

afterEach(() => {
  handle?.uninstall();
  handle = null;
  clearLegacyBridge();
});

describe('installLegacyCompat', () => {
  it('installs all documented window globals', () => {
    handle = installLegacyCompat();
    expect(win.eventSource).toBeInstanceOf(LegacyEventSource);
    expect(win.event_types).toBe(event_types);
    expect(win.extension_settings).toEqual({});
    expect(typeof win.jQuery).toBe('function');
    expect(win.$).toBe(win.jQuery);
    expect(win.SillyTavern).toBeDefined();
    expect(win.SillyTavern?.eventSource).toBe(win.eventSource);
    expect(win.SillyTavern?.event_types).toBe(event_types);
  });

  it('exposes a context wired to the global event source', () => {
    handle = installLegacyCompat();
    const context = handle.getContext();
    expect(context.eventSource).toBe(win.eventSource);
    expect(context.event_types).toBe(event_types);
    expect(win.SillyTavern?.getContext().eventSource).toBe(win.eventSource);

    const received: unknown[] = [];
    context.eventSource.on(event_types.CHAT_CHANGED, (data) => received.push(data));
    win.eventSource?.emit(event_types.CHAT_CHANGED, 'chat-42');
    expect(received).toEqual(['chat-42']);
  });

  it('is idempotent: reinstalling keeps the same event source', () => {
    handle = installLegacyCompat();
    const firstSource = handle.eventSource;
    const received: unknown[] = [];
    firstSource.on(event_types.APP_READY, (data) => received.push(data));

    const second = installLegacyCompat();
    expect(second.eventSource).toBe(firstSource);
    expect(win.eventSource).toBe(firstSource);

    second.eventSource.emit(event_types.APP_READY, 'ready');
    expect(received).toEqual(['ready']);
    second.uninstall();
  });

  it('preserves an existing extension_settings object', () => {
    const existing = { ext: { keep: true } };
    win.extension_settings = existing;
    handle = installLegacyCompat();
    expect(win.extension_settings).toBe(existing);
  });

  it('wires the host bridge into the context', () => {
    handle = installLegacyCompat(makeBridge());
    const context = handle.getContext();
    expect(context.characters).toEqual([{ id: 'c1', name: 'Alice' }]);
    expect(context.chatId).toBe('chat1');
    expect(context.chat).toEqual([{ role: 'user', content: 'hi' }]);
    expect(context.substituteMacros('hello {{user}}')).toBe('hello Alice');
    expect(context.getRequestHeaders()['X-CSRF']).toBe('token');
  });

  it('uninstall removes every installed global', () => {
    installLegacyCompat().uninstall();
    expect(win.SillyTavern).toBeUndefined();
    expect(win.eventSource).toBeUndefined();
    expect(win.event_types).toBeUndefined();
    expect(win.extension_settings).toBeUndefined();
    expect(win.jQuery).toBeUndefined();
    expect(win.$).toBeUndefined();
    handle = null;
  });
});
