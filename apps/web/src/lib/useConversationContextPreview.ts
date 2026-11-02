import { useEffect, useState } from 'react';
import {
  CONTEXT_TOKEN_DEFAULT,
  type Message,
  type PromptContextPreviewRequest,
} from '@neotavern/contracts';
import { estimateTokens } from '@neotavern/shared';
import { isKernelMode } from '../api/backend.js';
import { useChatPromptPreview, usePromptContextPreview, useSettings } from '../api/hooks.js';
import { summarizeContextUsage, summarizePlanUsage } from './contextUsage.js';

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

/**
 * Tokenizer provenance shown next to the context meter. Both planes report the
 * same pair: which tokenizer profile produced the numbers and whether it is a
 * local heuristic rather than a model-specific tokenizer.
 */
export interface ConversationContextPreviewInfo {
  tokenizer: {
    profile: string;
    approximate: boolean;
  };
}

interface ConversationContextPreviewInput {
  source: ConversationContextPreviewSource | undefined;
  draft: string;
}

/**
 * Shared live context preview used by both Home and existing chats.
 *
 * Two planes, two honest contracts (ARC-02):
 * - legacy sidecar: `POST /context-preview`, the sidecar pipeline's own
 *   preview shape (summarized by `summarizeContextUsage`);
 * - kernel: wire `chats.prompt.preview` for an EXISTING chat — the same
 *   planning pipeline that produces the durable prompt plan, built without a
 *   generation run (`summarizePlanUsage`). A new-chat preview has no kernel
 *   counterpart (the kernel planner is chat-scoped), so the meter falls back
 *   to the labeled local estimate instead of failing.
 */
export function useConversationContextPreview({ source, draft }: ConversationContextPreviewInput) {
  const settings = useSettings();
  const [previewDraft, setPreviewDraft] = useState(draft);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setPreviewDraft(draft), CONTEXT_PREVIEW_DEBOUNCE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [draft]);

  const providerConfigId = settings.data?.activeProviderConfigId;
  const legacyRequest: PromptContextPreviewRequest | undefined =
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
  const settled = previewDraft === draft;
  const cacheKey = { settings: settings.data, sourceVersion };

  const kernelMode = isKernelMode();
  const kernelChatId = source && 'chatId' in source ? source.chatId : undefined;
  const kernelRequest =
    kernelMode && kernelChatId !== undefined && settings.data
      ? { chatId: kernelChatId, userMessage: previewDraft }
      : undefined;
  const kernelPreview = useChatPromptPreview(kernelRequest, settled, cacheKey);
  const legacyPreview = usePromptContextPreview(
    kernelMode ? undefined : legacyRequest,
    settled,
    cacheKey,
  );

  const plan = kernelPreview.data?.plan ?? null;
  const legacy = legacyPreview.data?.preview ?? null;
  const outputLimit = settings.data?.generationDefaults?.maxTokens;
  const contextUsage = plan
    ? summarizePlanUsage(plan)
    : summarizeContextUsage(legacy, {
        contextLimit: settings.data?.maxContextTokens ?? CONTEXT_TOKEN_DEFAULT,
        reservedForReply: outputLimit ?? 4_000,
        historyTokens: estimateHistoryTokens(source),
        draftTokens: estimateTokens(draft),
      });
  const preview: ConversationContextPreviewInfo | null = plan
    ? { tokenizer: { profile: plan.tokenizerProfile, approximate: plan.approximateTokens } }
    : legacy
      ? { tokenizer: legacy.tokenizer }
      : null;
  const isFetching = kernelMode ? kernelPreview.isFetching : legacyPreview.isFetching;
  const isError = kernelMode ? kernelPreview.isError : legacyPreview.isError;
  const isLoading =
    preview === null && (previewDraft !== draft || isFetching || settings.isLoading);
  const triggerPending =
    preview === null && !isError && (settings.data === undefined || isFetching);

  return {
    contextUsage,
    preview,
    isLoading,
    isError,
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
