import { useEffect, useState } from 'react';
import {
  CONTEXT_TOKEN_DEFAULT,
  type Message,
  type PromptContextPreviewRequest,
} from '@neotavern/contracts';
import { estimateTokens } from '@neotavern/shared';
import { usePromptContextPreview, useSettings } from '../api/hooks.js';
import { summarizeContextUsage } from './contextUsage.js';

const CONTEXT_PREVIEW_DEBOUNCE_MS = 500;

export type ConversationContextPreviewSource =
  | {
      characterId: string;
      greeting: string;
      personaId?: string;
    }
  | {
      chatId: string;
      messages: readonly Message[];
      historyVersion: number;
    };

interface ConversationContextPreviewInput {
  source: ConversationContextPreviewSource | undefined;
  draft: string;
}

/** Shared live context preview used by both Home and existing chats. */
export function useConversationContextPreview({ source, draft }: ConversationContextPreviewInput) {
  const settings = useSettings();
  const [previewDraft, setPreviewDraft] = useState(draft);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setPreviewDraft(draft), CONTEXT_PREVIEW_DEBOUNCE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [draft]);

  const providerConfigId = settings.data?.activeProviderConfigId;
  const request: PromptContextPreviewRequest | undefined =
    source && settings.data
      ? 'chatId' in source
        ? {
            chatId: source.chatId,
            userMessage: previewDraft,
            ...(providerConfigId ? { providerConfigId } : {}),
          }
        : {
            characterId: source.characterId,
            userMessage: previewDraft,
            ...(providerConfigId ? { providerConfigId } : {}),
            ...(source.personaId ? { personaId: source.personaId } : {}),
          }
      : undefined;
  const sourceVersion = source
    ? 'chatId' in source
      ? source.historyVersion
      : source.greeting
    : null;
  const contextPreview = usePromptContextPreview(request, previewDraft === draft, {
    settings: settings.data,
    sourceVersion,
  });
  const preview = contextPreview.data?.preview ?? null;
  const outputLimit = settings.data?.generationDefaults?.maxTokens;
  const contextUsage = summarizeContextUsage(preview, {
    contextLimit: settings.data?.maxContextTokens ?? CONTEXT_TOKEN_DEFAULT,
    reservedForReply: outputLimit ?? 4_000,
    historyTokens: estimateHistoryTokens(source),
    draftTokens: estimateTokens(draft),
  });
  const isLoading =
    preview === null && (previewDraft !== draft || contextPreview.isFetching || settings.isLoading);
  const triggerPending =
    preview === null &&
    !contextPreview.isError &&
    (settings.data === undefined || contextPreview.isFetching);

  return {
    contextUsage,
    preview,
    isLoading,
    isError: contextPreview.isError,
    triggerPending,
  };
}

function estimateHistoryTokens(source: ConversationContextPreviewSource | undefined): number {
  if (!source) return 0;
  if (!('chatId' in source)) return estimateTokens(source.greeting);

  return source.messages.reduce((total, message) => {
    if (message.meta['manualExcluded'] === true) return total;
    const persistedTokens = message.meta['tokens'];
    return (
      total +
      (typeof persistedTokens === 'number' ? persistedTokens : estimateTokens(message.content))
    );
  }, 0);
}
