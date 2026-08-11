/**
 * Legacy event bus, API-compatible with SillyTavern's `eventSource` /
 * `event_types` (AGENTS.md §18). Old extensions subscribe with
 * `eventSource.on(event_types.X, handler)`; the new app emits through the same
 * surface.
 */

export const event_types = {
  APP_READY: 'app_ready',
  APP_LOAD: 'app_load',
  CHAT_CHANGED: 'chat_changed',
  CHAT_CREATED: 'chat_created',
  CHAT_DELETED: 'chat_deleted',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_RENDERED: 'message_rendered',
  CHARACTER_SELECTED: 'character_selected',
  CHARACTER_CREATED: 'character_created',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_DELETED: 'character_deleted',
  GENERATION_STARTED: 'generation_started',
  GENERATION_ENDED: 'generation_ended',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_AFTER_COMMANDS: 'generation_after_commands',
  SETTINGS_UPDATED: 'settings_updated',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  THEME_CHANGED: 'theme_changed',
  LANGUAGE_CHANGED: 'language_changed',
} as const;

export type LegacyEventType = (typeof event_types)[keyof typeof event_types];

export type LegacyEventHandler = (data?: unknown) => void;

export class LegacyEventSource {
  private readonly listeners = new Map<string, Set<LegacyEventHandler>>();

  on(event: string, handler: LegacyEventHandler): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: string, handler: LegacyEventHandler): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  once(event: string, handler: LegacyEventHandler): this {
    const wrapper: LegacyEventHandler = (data) => {
      this.off(event, wrapper);
      handler(data);
    };
    return this.on(event, wrapper);
  }

  emit(event: string, data?: unknown): this {
    const set = this.listeners.get(event);
    if (!set) return this;
    for (const handler of [...set]) {
      try {
        handler(data);
      } catch (error) {
        // A broken legacy listener must not break the emitter.
        console.error(`[legacy:eventSource] handler for "${event}" threw`, error);
      }
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }
}
