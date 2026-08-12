/** Keep the documented SillyTavern browser globals connected to live app data. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { buildMacroContext, estimateTokens, replaceMacros } from '@neotavern/shared';
import {
  clearLegacyBridge,
  event_types,
  setLegacyBridge,
  type LegacyBridge,
} from '@neotavern/legacy-compat';
import type {
  LegacyExtensionSettings,
  LegacyExtensionSettingsResponse,
  Message,
} from '@neotavern/contracts';
import { legacyRaw } from '../api/backend.js';
import { getCsrfToken } from '../api/client.js';
import { useCharacters, useChat, useMessages, usePersonas, useSettings } from '../api/hooks.js';
import { resolveActivePersona } from '../lib/macros.js';

const LEGACY_HISTORY_LIMIT = 100;

interface LegacyGlobals extends Window {
  eventSource?: { emit(event: string, payload?: unknown): unknown };
  extension_settings?: Record<string, LegacyExtensionSettings>;
}

export function LegacyBridgeSync() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const characters = useCharacters({ limit: 500 });
  const settings = useSettings();
  const personas = usePersonas();
  const chatId = useMemo(() => readChatId(location.pathname), [location.pathname]);
  const chat = useChat(chatId ?? undefined);
  const messages = useMessages(chatId ?? undefined, chat.data?.activeBranchId ?? undefined);
  const [extensionSettings, setExtensionSettings] = useState<
    Record<string, LegacyExtensionSettings>
  >({});
  const settingsRef = useRef(extensionSettings);
  const previousChatId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void legacyRaw()
      .request<LegacyExtensionSettingsResponse>('GET', '/legacy/extension-settings')
      .then((response) => {
        if (!active) return;
        settingsRef.current = response.items;
        setExtensionSettings(response.items);
        const win = window as LegacyGlobals;
        win.extension_settings = response.items;
        win.eventSource?.emit(event_types.EXTENSION_SETTINGS_LOADED, response.items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    settingsRef.current = extensionSettings;
    const characterItems = characters.data?.pages.flatMap((page) => page.items) ?? [];
    const activeCharacter = characterItems.find(
      (character) => character.id === chat.data?.characterId,
    );
    // Newest-first pages → oldest-first history, bounded.
    const history = (messages.data?.pages.flatMap((page) => page.items) ?? [])
      .slice(0, LEGACY_HISTORY_LIMIT)
      .reverse();
    const currentSettings = settings.data;
    const persona = resolveActivePersona(
      personas.data?.items ?? [],
      chat.data?.personaId,
      currentSettings?.activePersonaId,
    );
    const macroContext = buildMacroContext({
      userName: persona?.name,
      charName: activeCharacter?.name,
      variables: currentSettings?.macroVariables,
    });
    const bridge: LegacyBridge = {
      getCharacters: () =>
        characterItems.map((character) => ({ id: character.id, name: character.name })),
      getActiveChatId: () => chatId,
      getActiveCharacterId: () => chat.data?.characterId ?? null,
      getChatHistory: () =>
        history.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
        })),
      getTokenCount: (text) => estimateTokens(text),
      substituteMacros: (text) => replaceMacros(text, macroContext),
      generate: async () => {
        globalThis.dispatchEvent?.(new CustomEvent('neotavern-legacy-generate'));
      },
      getPowerUserSettings: () => ({
        language: currentSettings?.language ?? 'en',
        max_context: currentSettings?.maxContextTokens ?? 0,
        context_strategy: currentSettings?.contextStrategy ?? 'truncate',
        instruct_format: currentSettings?.instructFormatId ?? null,
        theme_id: document.documentElement.dataset.themeId ?? null,
      }),
      getRequestHeaders: () => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const csrf = getCsrfToken();
        if (csrf) headers['X-CSRF-Token'] = csrf;
        return headers;
      },
      async sendChatMessage(text) {
        if (!chatId || text.trim().length === 0) return;
        const message = await legacyRaw().request<Message>(
          'POST',
          `/chats/${encodeURIComponent(chatId)}/messages`,
          {
            role: 'user',
            content: text,
          },
        );
        await queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
        (window as LegacyGlobals).eventSource?.emit(event_types.MESSAGE_SENT, message);
      },
      getExtensionSettings: () => settingsRef.current,
      saveExtensionSettings(namespace, settingsToUpdate) {
        const next = { ...settingsRef.current, [namespace]: settingsToUpdate };
        settingsRef.current = next;
        setExtensionSettings(next);
        (window as LegacyGlobals).extension_settings = next;
        (window as LegacyGlobals).eventSource?.emit(event_types.SETTINGS_UPDATED, {
          namespace,
        });
        void legacyRaw()
          .request('PATCH', `/legacy/extension-settings/${encodeURIComponent(namespace)}`, {
            settings: settingsToUpdate,
          })
          .catch(() => undefined);
      },
    };
    setLegacyBridge(bridge);
    return () => clearLegacyBridge();
  }, [
    characters.data,
    chat.data?.characterId,
    chat.data?.personaId,
    chatId,
    personas.data?.items,
    queryClient,
    messages.data,
    settings.data,
  ]);

  useEffect(() => {
    if (previousChatId.current === chatId) return;
    previousChatId.current = chatId;
    (window as LegacyGlobals).eventSource?.emit(event_types.CHAT_CHANGED, chatId);
    if (chat.data?.characterId) {
      (window as LegacyGlobals).eventSource?.emit(
        event_types.CHARACTER_SELECTED,
        chat.data.characterId,
      );
    }
  }, [chat.data?.characterId, chatId]);

  useEffect(() => {
    (window as LegacyGlobals).eventSource?.emit(event_types.APP_READY);
  }, []);

  return null;
}

function readChatId(pathname: string): string | null {
  const match = /^\/chats\/([^/]+)$/u.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
