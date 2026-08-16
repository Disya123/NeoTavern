/**
 * App-level subscription to the server event channel (ТЗ §4.2, §11.1).
 *
 * The legacy SSE event stream (`GET` on the events route of the legacy
 * surface) exists so backend-driven changes — another tab, the legacy
 * bridge, server plugins — invalidate the relevant TanStack Query caches
 * instead of silently going stale. Before this subscriber, the stream was
 * only relayed into plugin sandboxes.
 *
 * **Kernel plane** (desktop local kernel, Android JNI, remote Headless):
 * there is no SSE channel and no second writer — the kernel is the single
 * writer and every mutation flows through the same TanStack Query caches in
 * this process. Opening the legacy event stream here would be a silent
 * legacy call (ARC-02), so the honest kernel behavior is a no-op
 * subscription (ТЗ §13.1: never silently touch the other backend). The
 * host-connect gate also has no legacy product API yet. The legacy contour
 * (Vite + sidecar) keeps the real stream until M7.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { BrowserAppEvent } from '@neotavern/contracts';
import { isKernelMode } from './backend.js';
import { needsHostConnect } from './hostSession.js';

/**
 * Server frame on the wire. The event names come from the shared contract
 * (BROWSER_APP_EVENTS); unknown future events fall through the switch's
 * default branch.
 */
interface AppEventEnvelope {
  type: string;
  event?: BrowserAppEvent | string;
  payload?: { chatId?: string; characterId?: string };
}

/**
 * Open the event stream and invalidate caches per event. Returns a teardown
 * function. EventSource reconnects on its own after network interruptions.
 */
export function connectAppEvents(queryClient: QueryClient): () => void {
  // Kernel plane: honest no-op (see the module docs) — never a silent legacy
  // surface call from kernel mode. The host-connect gate (Android / `?connect=`)
  // also has no legacy product API yet; opening EventSource against the static
  // Web Client would fetch `index.html` as `text/event-stream`.
  if (isKernelMode() || needsHostConnect()) {
    return () => undefined;
  }
  const source = new EventSource('/api/v2/events');

  const invalidate = (key: readonly unknown[]): void => {
    void queryClient.invalidateQueries({ queryKey: key });
  };

  source.onmessage = (message: MessageEvent<string>) => {
    let envelope: AppEventEnvelope;
    try {
      envelope = JSON.parse(message.data) as AppEventEnvelope;
    } catch {
      return; // Keep-alives and malformed frames carry no cache signal.
    }
    if (envelope.type !== 'event' || typeof envelope.event !== 'string') return;
    const chatId = envelope.payload?.chatId;
    switch (envelope.event) {
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
        // targets plugins — none require cache invalidation.
        break;
    }
  };

  return () => source.close();
}
