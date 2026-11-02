/**
 * Tests for the kernel-plane app-event cursor loop (cluster 18): the cursor
 * advances monotonically, a backlog drains without waiting, truncation is
 * surfaced once and the loop keeps going, failures retry with backoff without
 * losing the cursor, and teardown stops everything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAppEventPolling, type AppEventPage } from './appEventPoller.js';

function page(overrides: Partial<AppEventPage> = {}): AppEventPage {
  return { items: [], hasMore: false, truncated: false, ...overrides };
}

function item(sequence: number, event = 'chat.message.created') {
  return {
    sequence,
    event,
    payload: { chatId: 'chat-1' },
    createdAt: '2026-08-13T00:00:00Z',
  };
}

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startAppEventPolling', () => {
  it('starts at the beginning of the retained log and advances the cursor', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce(page({ items: [item(1), item(2)] }))
      .mockResolvedValue(page({ items: [item(3)] }));
    const onEvent = vi.fn();
    stop = startAppEventPolling({ poll, onEvent });

    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenNthCalledWith(1, -1, expect.any(AbortSignal));
    expect(onEvent.mock.calls).toEqual([
      ['chat.message.created', { chatId: 'chat-1' }],
      ['chat.message.created', { chatId: 'chat-1' }],
    ]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(poll).toHaveBeenNthCalledWith(2, 2, expect.any(AbortSignal));
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it('drains a backlog immediately instead of waiting for the interval', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce(page({ items: [item(1)], hasMore: true }))
      .mockResolvedValueOnce(page({ items: [item(2)] }))
      .mockResolvedValue(page({}));
    const onEvent = vi.fn();
    stop = startAppEventPolling({ poll, onEvent });

    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(poll.mock.calls.at(1)?.[0]).toBe(1);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('reports truncation once and continues from the retained rows', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce(page({ items: [item(9)], truncated: true }))
      .mockResolvedValue(page({}));
    const onTruncated = vi.fn();
    const onEvent = vi.fn();
    stop = startAppEventPolling({ poll, onEvent, onTruncated });

    await vi.advanceTimersByTimeAsync(0);
    expect(onTruncated).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenNthCalledWith(1, -1, expect.any(AbortSignal));
  });

  it('keeps the cursor across failures and backs off exponentially', async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport down'))
      .mockRejectedValueOnce(new Error('transport down again'))
      .mockResolvedValue(page({ items: [item(4)] }));
    const onEvent = vi.fn();
    stop = startAppEventPolling({ poll, onEvent, retryMs: 100, maxBackoffMs: 10_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    // First retry after 100 ms, second after 200 ms.
    await vi.advanceTimersByTimeAsync(99);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(poll.mock.calls.at(2)?.[0]).toBe(-1);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('stops polling after teardown and ignores a pending response', async () => {
    let resolve: ((value: AppEventPage) => void) | undefined;
    const poll = vi.fn(
      () =>
        new Promise<AppEventPage>((done) => {
          resolve = done;
        }),
    );
    const onEvent = vi.fn();
    stop = startAppEventPolling({ poll, onEvent });
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledOnce();

    stop();
    stop = undefined;
    resolve?.(page({ items: [item(1)] }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onEvent).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledOnce();
  });
});
