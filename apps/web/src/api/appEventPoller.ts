/**
 * Kernel-plane app-event subscription (M7 Этап-4 cluster 18).
 *
 * The legacy contour pushes app events over one SSE stream; the canonical
 * plane has one writer and a durable, resumable event log, so a subscriber
 * POLLS a cursor instead of holding a socket open:
 *
 * - the cursor starts at `-1` (everything still retained) and advances to the
 *   last `sequence` received, so a reload, a second tab or a reconnect never
 *   depends on being connected at the exact moment of a change;
 * - `hasMore` means "a backlog larger than one page" — the loop polls again
 *   immediately instead of waiting a tick;
 * - `truncated` means the cursor aged out of the bounded retention window:
 *   the subscriber is told to reset its caches, then continues from the oldest
 *   retained row (it never pretends it saw every change);
 * - a failed poll keeps the cursor and backs off, so delivery stays
 *   at-least-once instead of silently skipping events.
 *
 * Latency is bounded by the poll interval (default 2 s), which is the honest
 * tradeoff of a durable log without a push transport. The loop is owned by the
 * caller: `stop()` cancels the pending timer/request and nothing else.
 */

/** Minimal shape of one relayed event (wire `wire.app-event`). */
export interface AppEventItem {
  sequence: number;
  event: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** One page of the app-event log (wire `wire.result.app-events-page`). */
export interface AppEventPage {
  items: AppEventItem[];
  hasMore: boolean;
  truncated: boolean;
}

export interface AppEventPollingOptions {
  /** Fetch one page strictly after `afterSequence` (exclusive cursor). */
  poll: (afterSequence: number, signal: AbortSignal) => Promise<AppEventPage>;
  /** Called for every event, in sequence order. */
  onEvent: (event: string, payload: Record<string, unknown>) => void;
  /** The cursor aged out: reset caches, then the loop keeps going. */
  onTruncated?: () => void;
  /** Idle poll interval in ms (default 2000). */
  intervalMs?: number;
  /** First retry delay after a failed poll; doubles up to `maxBackoffMs`. */
  retryMs?: number;
  maxBackoffMs?: number;
}

/** Delay between idle polls: 2 s keeps invalidation prompt without busy-work. */
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * Start polling the app-event log. Returns a teardown function; after it runs
 * no callback fires again (a pending response is ignored).
 */
export function startAppEventPolling(options: AppEventPollingOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let cursor = -1;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    controller = new AbortController();
    let page: AppEventPage;
    try {
      page = await options.poll(cursor, controller.signal);
    } catch {
      // Keep the cursor: the next successful poll replays the gap, so a
      // transient failure can never drop an event.
      failures += 1;
      schedule(Math.min(retryMs * 2 ** (failures - 1), maxBackoffMs));
      return;
    } finally {
      controller = undefined;
    }
    if (stopped) return;
    failures = 0;
    if (page.truncated) options.onTruncated?.();
    for (const item of page.items) {
      if (stopped) return;
      cursor = Math.max(cursor, item.sequence);
      options.onEvent(item.event, item.payload);
    }
    schedule(page.hasMore ? 0 : intervalMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  };
}
