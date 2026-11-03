/**
 * App-level subscription to the server event channel (ТЗ §4.2, §11.1).
 *
 * The legacy plane pushes frames over SSE; the canonical plane has a single
 * writer and a durable app-event log, so the same invalidations are driven by
 * a cursor poll (see `appEventPoller`). Either way the purpose is identical:
 * backend-driven changes — another tab, the legacy bridge, a plugin, another
 * client of the remote kernel — invalidate the relevant TanStack Query caches
 * instead of silently going stale.
 *
 * The kernel path is also what makes cross-client block changes real: the
 * plugin bridge's own `chat.message.block.changed` handler was already
 * listening on `runtime.onAppEvent`, and the kernel log now feeds it (cluster
 * 18 closes the boundary cluster 15 documented).
 */
import type { QueryClient } from '@tanstack/react-query';
import type { BrowserAppEvent } from '@neotavern/contracts';
import { startAppEventPolling } from './appEventPoller.js';
import { isKernelMode } from './backend.js';
import { needsHostConnect } from './hostSession.js';
import { pollAppEvents } from './wireBridge.js';

/**
 * Server frame on the legacy wire. The event names come from the shared
 * contract (BROWSER_APP_EVENTS); unknown future events fall through the
 * switch's default branch.
 */
interface AppEventEnvelope {
  type: string;
  event?: BrowserAppEvent | string;
  payload?: { chatId?: string; characterId?: string };
}

/** Payload ids the invalidations need (ids only — never message text). */
interface AppEventIds {
  chatId?: string;
  messageId?: string;
}

/**
 * Query keys one relayed event invalidates. Pure mapping shared by both
 * transports so the kernel and the legacy contour cannot drift apart in what
 * they invalidate.
 */
export function keysForAppEvent(
  event: string,
  payload: AppEventIds | undefined,
): readonly (readonly unknown[])[] {
  const chatId = payload?.chatId;
  switch (event) {
    case 'chat.created':
    case 'chat.opened':
      return [['chats']];
    case 'chat.message.created':
    case 'chat.message.updated':
    case 'chat.message.deleted':
      return chatId ? [['messages', chatId], ['chat', chatId], ['chats']] : [['chats']];
    case 'generation.finished':
    case 'generation.error':
      return chatId ? [['messages', chatId], ['chat', chatId], ['chats']] : [];
    case 'plugin.installed':
    case 'plugin.updating':
    case 'plugin.updated':
    case 'plugin.rollback':
    case 'plugin.activated':
    case 'plugin.disabled':
    case 'plugin.uninstalling':
    case 'plugin.deleted':
      return [['plugins']];
    default:
      // generation.started/delta are streaming noise and character.selected
      // targets plugins вЂ” none require cache invalidation. Block changes are
      // handled by the plugin bridge (it owns the block cache), not here.
      return [];
  }
}

/**
 * Apply one relayed event to the query cache. Shared by both transports so the
 * kernel and the legacy contour cannot drift apart in what they invalidate.
 * The kernel plane coalesces per event PAGE (see connectAppEvents): replaying
 * a long retained backlog must not fire one refetch per replayed event.
 */
export function invalidateForAppEvent(
  queryClient: QueryClient,
  event: string,
  payload: AppEventIds | undefined,
): void {
  const invalidate = (key: readonly unknown[]): void => {
    void queryClient.invalidateQueries({ queryKey: key });
  };
  for (const key of keysForAppEvent(event, payload)) {
    invalidate(key);
  }
}

/**
 * Open the event channel and invalidate caches per event. Returns a teardown
 * function. The legacy plane uses `EventSource` (it reconnects on its own);
 * the kernel plane polls the durable cursor.
 */
export function connectAppEvents(queryClient: QueryClient): () => void {
  // Host-connect gate (Android / `?connect=`) has no legacy product API yet;
  // opening EventSource against the static Web Client would fetch `index.html`
  // as `text/event-stream`.
  if (!isKernelMode() && needsHostConnect()) {
    return () => undefined;
  }

  if (isKernelMode()) {
    // Coalesce per event page: the durable log replays retained backlogs in
    // batches (a fresh session over a long-lived kernel starts at cursor -1),
    // and one refetch per replayed event turns that into a request storm.
    // Each page collapses into one refetch per distinct query key instead.
    let pageKeys = new Set<string>();
    return startAppEventPolling({
      poll: (afterSequence, signal) => pollAppEvents(afterSequence, signal),
      onEvent: (event, payload) => {
        for (const key of keysForAppEvent(event, payload as AppEventIds)) {
          pageKeys.add(JSON.stringify(key));
        }
      },
      onBatch: () => {
        const pending = [...pageKeys];
        pageKeys = new Set<string>();
        for (const key of pending) {
          void queryClient.invalidateQueries({ queryKey: JSON.parse(key) as readonly unknown[] });
        }
      },
      // The cursor aged out of retention: we cannot prove what we missed, so
      // every server-state cache is refetched rather than kept half-stale.
      onTruncated: () => {
        void queryClient.invalidateQueries();
      },
    });
  }

  const source = new EventSource('/api/v2/events');

  source.onmessage = (message: MessageEvent<string>) => {
    let envelope: AppEventEnvelope;
    try {
      envelope = JSON.parse(message.data) as AppEventEnvelope;
    } catch {
      return; // Keep-alives and malformed frames carry no cache signal.
    }
    if (envelope.type !== 'event' || typeof envelope.event !== 'string') return;
    invalidateForAppEvent(queryClient, envelope.event, envelope.payload);
  };

  return () => source.close();
}
