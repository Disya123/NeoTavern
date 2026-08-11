/**
 * Rev4 chat slice (contract §6 A5): re-emits chat message lifecycle events on
 * the app bus as the plugin-namespaced `plugin.chat.updated` event so plugins
 * can subscribe to a stable surface without parsing app events. Payloads carry
 * identifiers and role only — never message content (chat content stays
 * behind the `chat.read` gate, mirroring backendHost CHAT_CONTENT_EVENTS).
 *
 * Delivery: backend plugins receive the namespaced event through the worker
 * `event.emit` channel; sandboxed frontends receive it through the SSE
 * whitelist (`plugin.chat.updated` in `plugins/events.ts` STREAM_EVENTS).
 * No REST endpoint is exposed here.
 */
import type { AppContext, TypedApp } from '../types.js';

/** Namespaced event carrying a chat message lifecycle change (rev4 chats). */
export const PLUGIN_CHAT_UPDATED_EVENT = 'plugin.chat.updated';

export interface PluginChatUpdatedPayload {
  chatId: string;
  messageId: string;
  role?: string;
}

/**
 * Subscribe to `chat.message.*` bus events and re-emit them as
 * `plugin.chat.updated`. Returns an unsubscribe function for teardown.
 */
export function registerPluginChatRelay(_app: TypedApp, ctx: AppContext): () => void {
  const relay = (payload: PluginChatUpdatedPayload): void => {
    // Whitelist fields explicitly so stray event data (content, extras)
    // never leaks into the plugin-namespaced surface.
    const namespaced: PluginChatUpdatedPayload = {
      chatId: payload.chatId,
      messageId: payload.messageId,
      role: typeof payload.role === 'string' ? payload.role : undefined,
    };
    ctx.events.emit(PLUGIN_CHAT_UPDATED_EVENT, namespaced);
  };
  const unsubscribes = [
    ctx.events.on('chat.message.created', relay),
    ctx.events.on('chat.message.updated', relay),
    ctx.events.on('chat.message.deleted', relay),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
