/** Tests for connectAppEvents: SSE frames drive precise cache invalidation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { connectAppEvents } from './events.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(data: string): void {
    this.onmessage?.(new MessageEvent<string>('message', { data }));
  }

  static get latest(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1);
    if (!instance) throw new Error('no EventSource constructed');
    return instance;
  }
}

let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof vi.spyOn>;
let teardown: () => void;
let source: FakeEventSource;

function frame(envelope: unknown): void {
  source.emit(JSON.stringify(envelope));
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  queryClient = new QueryClient();
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  teardown = connectAppEvents(queryClient);
  source = FakeEventSource.latest;
});

afterEach(() => {
  teardown();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('connectAppEvents', () => {
  it('opens the event stream on the API base', () => {
    expect(source.url).toBe('/api/v2/events');
  });

  it('ignores non-event envelopes such as the ready frame', () => {
    frame({ type: 'ready', at: Date.now() });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates the chat list on chat.created', () => {
    frame({ type: 'event', event: 'chat.created', payload: {} });
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['chats'] });
  });

  it('invalidates the chat list on chat.opened', () => {
    frame({ type: 'event', event: 'chat.opened', payload: { chatId: 'chat-2' } });
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['chats'] });
  });

  it('invalidates messages, chat detail and the list for message events with a chatId', () => {
    frame({ type: 'event', event: 'chat.message.created', payload: { chatId: 'chat-7' } });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
    expect(invalidateSpy).toHaveBeenNthCalledWith(1, { queryKey: ['messages', 'chat-7'] });
    expect(invalidateSpy).toHaveBeenNthCalledWith(2, { queryKey: ['chat', 'chat-7'] });
    expect(invalidateSpy).toHaveBeenNthCalledWith(3, { queryKey: ['chats'] });
  });

  it('invalidates only the chat list for message events without a chatId', () => {
    frame({ type: 'event', event: 'chat.message.deleted' });
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['chats'] });
  });

  it('invalidates chat caches when a generation finishes for a chat', () => {
    frame({ type: 'event', event: 'generation.finished', payload: { chatId: 'chat-3' } });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
    expect(invalidateSpy).toHaveBeenNthCalledWith(1, { queryKey: ['messages', 'chat-3'] });
    expect(invalidateSpy).toHaveBeenNthCalledWith(2, { queryKey: ['chat', 'chat-3'] });
    expect(invalidateSpy).toHaveBeenNthCalledWith(3, { queryKey: ['chats'] });
  });

  it('invalidates nothing for generation.finished without a chatId', () => {
    frame({ type: 'event', event: 'generation.finished', payload: {} });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('treats streaming deltas as noise', () => {
    frame({ type: 'event', event: 'generation.delta', payload: { chatId: 'chat-3' } });
    frame({ type: 'event', event: 'generation.started', payload: { chatId: 'chat-3' } });
    frame({ type: 'event', event: 'character.selected', payload: { characterId: 'char-1' } });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates the plugin list on plugin lifecycle events', () => {
    frame({ type: 'event', event: 'plugin.installed', payload: { pluginId: 'p' } });
    frame({ type: 'event', event: 'plugin.activated', payload: { pluginId: 'p' } });
    frame({ type: 'event', event: 'plugin.disabled', payload: { pluginId: 'p' } });
    frame({ type: 'event', event: 'plugin.deleted', payload: { pluginId: 'p' } });
    expect(invalidateSpy).toHaveBeenCalledTimes(4);
    expect(invalidateSpy).toHaveBeenNthCalledWith(4, { queryKey: ['plugins'] });
  });

  it('ignores envelopes without a string event name', () => {
    frame({ type: 'event' });
    frame({ type: 'event', event: 42 });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('survives malformed JSON and keep-alive frames without throwing', () => {
    expect(() => source.emit('not json {')).not.toThrow();
    expect(() => source.emit('')).not.toThrow();
    expect(invalidateSpy).not.toHaveBeenCalled();
    // The stream keeps working after garbage.
    frame({ type: 'event', event: 'chat.created', payload: {} });
    expect(invalidateSpy).toHaveBeenCalledOnce();
  });

  it('keeps handling frames in sequence', () => {
    frame({ type: 'event', event: 'chat.created', payload: {} });
    invalidateSpy.mockClear();
    frame({ type: 'event', event: 'chat.message.updated', payload: { chatId: 'chat-9' } });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
    expect(invalidateSpy).toHaveBeenNthCalledWith(1, { queryKey: ['messages', 'chat-9'] });
  });

  it('teardown closes the event source', () => {
    teardown();
    expect(source.close).toHaveBeenCalledOnce();
  });
});
