/** Tests for connectAppEvents on the kernel plane (durable cursor polling). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { connectAppEvents, invalidateForAppEvent } from './events.js';

const mocks = vi.hoisted(() => ({
  isKernelMode: vi.fn(() => true),
  needsHostConnect: vi.fn(() => false),
  pollAppEvents: vi.fn(),
}));
vi.mock('./backend.js', () => ({ isKernelMode: mocks.isKernelMode }));
vi.mock('./hostSession.js', () => ({ needsHostConnect: mocks.needsHostConnect }));
vi.mock('./wireBridge.js', () => ({ pollAppEvents: mocks.pollAppEvents }));

let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof vi.spyOn>;
let teardown: () => void;

beforeEach(() => {
  mocks.isKernelMode.mockReturnValue(true);
  mocks.needsHostConnect.mockReturnValue(false);
  mocks.pollAppEvents.mockReset();
  mocks.pollAppEvents.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  queryClient = new QueryClient();
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  teardown = connectAppEvents(queryClient);
});

afterEach(() => {
  teardown();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe('connectAppEvents', () => {
  it('polls the durable cursor on the kernel plane instead of opening a stream', async () => {
    await vi.waitFor(() => expect(mocks.pollAppEvents).toHaveBeenCalled());
    expect(mocks.pollAppEvents).toHaveBeenCalledWith(-1, expect.any(AbortSignal));
  });

  it('does not construct an EventSource on the kernel plane', () => {
    const ctor = vi.fn();
    vi.stubGlobal('EventSource', ctor);
    const localTeardown = connectAppEvents(queryClient);
    expect(ctor).not.toHaveBeenCalled();
    localTeardown();
    vi.unstubAllGlobals();
  });
});

describe('invalidateForAppEvent', () => {
  it('invalidates the chat list on chat.created', () => {
    invalidateForAppEvent(queryClient, 'chat.created', {});
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['chats'] });
  });

  it('invalidates messages, chat detail and the list for message events with a chatId', () => {
    invalidateForAppEvent(queryClient, 'chat.message.created', { chatId: 'chat-7' });
    // The concrete keys are the transport's business; the contract is that the
    // message page, the chat detail and the chat list all get invalidated.
    const keys = invalidateSpy.mock.calls.map((call: unknown[]) => JSON.stringify(call[0]));
    expect(keys.some((key: string) => key.includes('chat-7'))).toBe(true);
    expect(keys.some((key: string) => key.includes('messages'))).toBe(true);
    expect(keys.some((key: string) => key.includes('"chats"'))).toBe(true);
  });

  it('ignores an unknown event name', () => {
    invalidateForAppEvent(queryClient, 'not.a.real.event', {});
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
