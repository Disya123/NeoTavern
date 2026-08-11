/**
 * Documented legacy context — the `SillyTavern.getContext()` surface old
 * extensions rely on (AGENTS.md §18). The host app installs a {@link LegacyBridge}
 * that maps these calls onto the new architecture; without a bridge the methods
 * return safe empty defaults instead of throwing.
 */
import { event_types, type LegacyEventSource } from './eventSource.js';
import {
  registerLegacyPromptInterceptor,
  registerLegacySlashCommand,
  type LegacyPromptInterceptor,
  type LegacySlashCommand,
} from './registry.js';

export interface LegacyCharacterInfo {
  id: string;
  name: string;
}

export interface LegacyChatMessage {
  role: string;
  content: string;
  name?: string;
}

/** Host-provided implementation of the documented legacy operations. */
export interface LegacyBridge {
  getCharacters(): LegacyCharacterInfo[];
  getActiveChatId(): string | null;
  getActiveCharacterId(): string | null;
  sendChatMessage(text: string): Promise<void>;
  getExtensionSettings(): Record<string, Record<string, unknown>>;
  saveExtensionSettings(namespace: string, settings: Record<string, unknown>): void;
  /** Recent chat history, oldest first (documented `context.chat`). */
  getChatHistory(): LegacyChatMessage[];
  /** Local token estimate (documented `getTokenCount`). */
  getTokenCount(text: string): number;
  /** Resolve {{user}}/{{char}}/custom macros (documented `substituteMacros`). */
  substituteMacros(text: string): string;
  /** Trigger a generation cycle (documented `generate`). */
  generate(): Promise<void>;
  /** Subset of power-user settings legacy extensions read. */
  getPowerUserSettings(): Record<string, unknown>;
  /** Real request headers incl. CSRF for remote mode (documented helper). */
  getRequestHeaders(): Record<string, string>;
}

let activeBridge: LegacyBridge | null = null;

export function setLegacyBridge(bridge: LegacyBridge): void {
  activeBridge = bridge;
}

export function clearLegacyBridge(): void {
  activeBridge = null;
}

/** The object returned by `SillyTavern.getContext()`. */
export interface LegacyContext {
  eventSource: LegacyEventSource;
  event_types: typeof event_types;
  characters: LegacyCharacterInfo[];
  chatId: string | null;
  characterId: string | null;
  /** Recent messages of the active chat, oldest first. */
  chat: LegacyChatMessage[];
  extension_settings: Record<string, Record<string, unknown>>;
  power_user: Record<string, unknown>;
  sendChatMessage(text: string): Promise<void>;
  getRequestHeaders(): Record<string, string>;
  saveExtensionSettings(namespace: string, settings: Record<string, unknown>): void;
  /** Resolve macros in a string ({{user}}, {{char}}, …). */
  substituteMacros(text: string): string;
  /** Local, offline token count estimate. */
  getTokenCount(text: string): number;
  /** Trigger a generation cycle for the active chat. */
  generate(): Promise<void>;
  /** Register a /command (ТЗ §8.1). Returns an unregister function. */
  registerSlashCommand(
    name: string,
    handler: (args: string) => unknown,
    description?: string,
  ): () => void;
  /** Register a prompt interceptor (ТЗ §8.1). Returns an unregister function. */
  registerPromptInterceptor(interceptor: LegacyPromptInterceptor): () => void;
}

export function createLegacyContext(eventSource: LegacyEventSource): LegacyContext {
  return {
    eventSource,
    event_types,
    get characters() {
      return activeBridge?.getCharacters() ?? [];
    },
    get chatId() {
      return activeBridge?.getActiveChatId() ?? null;
    },
    get characterId() {
      return activeBridge?.getActiveCharacterId() ?? null;
    },
    get chat() {
      // Optional calls: hosts built against the older bridge shape keep
      // working and simply see empty defaults for the newer members.
      return activeBridge?.getChatHistory?.() ?? [];
    },
    get extension_settings() {
      return activeBridge?.getExtensionSettings() ?? {};
    },
    get power_user() {
      return activeBridge?.getPowerUserSettings?.() ?? {};
    },
    sendChatMessage(text: string) {
      return activeBridge?.sendChatMessage(text) ?? Promise.resolve();
    },
    getRequestHeaders() {
      return activeBridge?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
    },
    saveExtensionSettings(namespace: string, settings: Record<string, unknown>) {
      activeBridge?.saveExtensionSettings(namespace, settings);
    },
    substituteMacros(text: string) {
      return activeBridge?.substituteMacros?.(text) ?? text;
    },
    getTokenCount(text: string) {
      return activeBridge?.getTokenCount?.(text) ?? Math.max(1, Math.ceil(text.length / 4));
    },
    generate() {
      return activeBridge?.generate?.() ?? Promise.resolve();
    },
    registerSlashCommand(
      name: string,
      handler: (args: string) => unknown,
      description?: string,
    ): () => void {
      const command: LegacySlashCommand = {
        name,
        handler,
        ...(description ? { description } : {}),
      };
      return registerLegacySlashCommand(command);
    },
    registerPromptInterceptor(interceptor: LegacyPromptInterceptor): () => void {
      return registerLegacyPromptInterceptor(interceptor);
    },
  };
}
