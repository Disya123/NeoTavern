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
 * Apply one relayed event to the query cache. Shared by both transports so the
 * kernel and the legacy contour cannot drift apart in what they invalidate.
 */
export function invalidateForAppEvent(
  queryClient: QueryClient,
  event: string,
  payload: AppEventIds | undefined,
): void {
  const invalidate = (key: readonly unknown[]): void => {
    void queryClient.invalidateQueries({ queryKey: key });
  };
  const chatId = payload?.chatId;
  switch (event) {
    case 'chat.created':
    case 'chat.opened':
      invalidate(['chats']);
      break;
    case 'chat.message.created':
    case 'chat.message.updated':
    case 'chat.message.deleted':
      if (chatId) {
        invalidate(['messages', chatId]);
        invalidate(['chat', chatId]);
      }
      invalidate(['chats']);
      break;
    case 'generation.finished':
    case 'generation.error':
      if (chatId) {
        invalidate(['messages', chatId]);
        invalidate(['chat', chatId]);
        invalidate(['chats']);
      }
      break;
    case 'plugin.installed':
    case 'plugin.updating':
    case 'plugin.updated':
    case 'plugin.rollback':
    case 'plugin.activated':
    case 'plugin.disabled':
    case 'plugin.uninstalling':
    case 'plugin.deleted':
      invalidate(['plugins']);
      break;
    default:
      // generation.started/delta are streaming noise and character.selected
      // targets plugins — none require cache invalidation. Block changes are
      // handled by the plugin bridge (it owns the block cache), not here.
      break;
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
    return startAppEventPolling({
      poll: (afterSequence, signal) => pollAppEvents(afterSequence, signal),
      onEvent: (event, payload) => {
        invalidateForAppEvent(queryClient, event, payload as AppEventIds);
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
