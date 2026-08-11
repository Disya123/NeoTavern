/** Shared test helpers for legacy-compat suites (DUP-26). */
import type { LegacyBridge } from '../src/index.js';

/**
 * A full in-memory host bridge with deterministic fixtures. Superset of the
 * older 6-method variant — contexts read members defensively, so passing the
 * full bridge is safe for tests that used the subset.
 */
export function makeBridge(overrides: Partial<LegacyBridge> = {}): LegacyBridge {
  return {
    getCharacters: () => [{ id: 'c1', name: 'Alice' }],
    getActiveChatId: () => 'chat1',
    getActiveCharacterId: () => 'c1',
    sendChatMessage: async () => undefined,
    getExtensionSettings: () => ({ ext: { foo: 1 } }),
    saveExtensionSettings: () => undefined,
    getChatHistory: () => [{ role: 'user', content: 'hi' }],
    getTokenCount: () => 3,
    substituteMacros: (text: string) => text.replaceAll('{{user}}', 'Alice'),
    generate: async () => undefined,
    getPowerUserSettings: () => ({ theme: 'dark' }),
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF': 'token' }),
    ...overrides,
  };
}
