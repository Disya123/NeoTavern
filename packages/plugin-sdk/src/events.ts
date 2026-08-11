/**
 * Typed event bus shared by the app and plugins. `on()` returns an unsubscribe
 * function so plugins can clean up on deactivation.
 */

export type EventMap = Record<string, unknown>;
export type EventHandler<T> = (payload: T) => void;

type HandlerSet<T> = Set<EventHandler<T>>;

export class EventBus<TEvents extends EventMap> {
  private handlers: { [K in keyof TEvents]?: HandlerSet<TEvents[K]> } = {};

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): () => void {
    const existing = this.handlers[event];
    const set: HandlerSet<TEvents[K]> = existing ?? new Set<EventHandler<TEvents[K]>>();
    if (!existing) this.handlers[event] = set;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** Unsubscribe a handler. */
  off<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): void {
    this.handlers[event]?.delete(handler);
  }

  /** Emit an event to all current subscribers. */
  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const set = this.handlers[event];
    if (!set) return;
    // Copy so handlers that unsubscribe during emit don't skip siblings.
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {
        // A misbehaving subscriber must not break the bus.
      }
    }
  }

  /** Remove all subscriptions (used on full teardown). */
  clear(): void {
    this.handlers = {};
  }
}

/**
 * Built-in application events. Plugins may also emit/listen to custom events
 * via the index signature (namespaced by convention, e.g. "myplugin.foo").
 */
export interface AppEventMap {
  'chat.created': { chatId: string };
  'chat.opened': { chatId: string };
  'chat.message.created': { chatId: string; messageId: string; role: string };
  'chat.message.updated': { chatId: string; messageId: string; role?: string; revision?: number };
  'chat.message.deleted': { chatId: string; messageId: string; role?: string };
  'chat.message.block.changed': { chatId: string; messageId: string; blockId: string };
  'character.selected': { characterId: string };
  'generation.started': { chatId: string };
  'generation.delta': { chatId: string; text: string };
  'generation.finished': { chatId: string; text: string };
  'generation.error': { chatId: string; code: string };
  'theme.changed': { themeId: string | null };
  'language.changed': { language: string };
  [key: string]: unknown;
}

export type PluginEventBus = EventBus<AppEventMap>;
