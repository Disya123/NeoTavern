import { createElement, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROMPT_TEMPLATE,
  type AppSettings,
  type PromptContextPreviewResponse,
} from '@neotavern/contracts';
import { createQueryClient, jsonResponse } from '../../test/helpers.js';
import { setCsrfToken } from '../api/client.js';
import {
  useConversationContextPreview,
  type ConversationContextPreviewSource,
} from './useConversationContextPreview.js';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

const settings: AppSettings = {
  language: 'en',
  themeId: null,
  activeProviderConfigId: null,
  activePersonaId: null,
  contextStrategy: 'truncate',
  maxContextTokens: 16_032,
  generationDefaults: { maxTokens: 2_048, temperature: 0.8, stream: true },
  instructFormat: null,
  instructFormatId: null,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  activeGenerationPresetId: null,
  activePromptTemplatePresetId: null,
  macroVariables: {},
  ui: {},
};

interface HookProps {
  source: ConversationContextPreviewSource;
  draft: string;
}

let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let serverContextLimit: number;
let requests: Array<Record<string, unknown>>;

beforeEach(() => {
  setCsrfToken(null);
  queryClient = createQueryClient();
  queryClient.setQueryData(['settings'], settings);
  serverContextLimit = settings.maxContextTokens;
  requests = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/v2/context-preview');
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse(previewResponse(serverContextLimit));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setCsrfToken(null);
});

describe('useConversationContextPreview', () => {
  it('uses one live-preview flow for character and chat sources and reacts to settings', async () => {
    const characterSource: ConversationContextPreviewSource = {
      characterId: '018f0000-0000-7000-8000-000000000301',
      greeting: 'Welcome to the orchard.',
    };
    const chatSource: ConversationContextPreviewSource = {
      chatId: '018f0000-0000-7000-8000-000000000302',
      messages: [],
      historyVersion: 1,
    };
    const { result, rerender } = renderHook<
      ReturnType<typeof useConversationContextPreview>,
      HookProps
    >(({ source, draft }) => useConversationContextPreview({ source, draft }), {
      initialProps: { source: characterSource, draft: 'Hello' },
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.contextUsage.isExact).toBe(true));
    expect(requests[0]).toEqual({
      characterId: characterSource.characterId,
      userMessage: 'Hello',
    });

    rerender({ source: chatSource, draft: 'Continue' });
    await waitFor(() => expect(requests).toHaveLength(2));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    expect(requests[1]).toEqual({ chatId: chatSource.chatId, userMessage: 'Continue' });

    serverContextLimit = 32_768;
    act(() => {
      queryClient.setQueryData(['settings'], { ...settings, maxContextTokens: serverContextLimit });
    });
    await waitFor(() => expect(result.current.contextUsage.contextLimit).toBe(serverContextLimit));
    expect(requests).toHaveLength(3);
  });
});

function previewResponse(contextLimit: number): PromptContextPreviewResponse {
  return {
    preview: {
      providerConfigId: null,
      providerKind: 'echo',
      providerSource: null,
      model: 'echo',
      chatTemplateId: null,
      promptTemplateId: null,
      promptTemplateMode: 'chat',
      tokenizer: { profile: 'test:exact', approximate: false },
      budget: {
        contextLimit,
        reservedForReply: 2_048,
        promptTokens: 128,
      },
      contextStrategy: 'truncate',
      entries: [],
      providerMessages: [],
      diagnostics: [],
    },
  };
}
