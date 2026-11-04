/**
 * Kernel-plane live context preview (M7 Etap-4 cluster 17 part 2).
 *
 * On the Product Wire plane the meter is fed by `chats.prompt.preview` — the
 * plan the next turn WOULD send, built without a generation run — for existing
 * chats, while a brand-new chat has no kernel preview (the kernel planner is
 * chat-scoped) and falls back to the labeled local estimate instead of an
 * error banner. The legacy `/context-preview` route is never called here.
 */
import { createElement, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROMPT_TEMPLATE, type AppSettings } from '@neotavern/contracts';
import { createQueryClient } from '../../test/helpers.js';
import type { ChatPromptPreviewRequestDto, ChatPromptPreviewResultDto } from '@neotavern/contracts';
import {
  useConversationContextPreview,
  type ConversationContextPreviewSource,
} from './useConversationContextPreview.js';

const hoisted = vi.hoisted(() => ({
  previewPrompt: vi.fn(),
  fetchSpy: vi.fn(),
}));

vi.mock('../api/backend.js', () => ({
  backend: { chats: { previewPrompt: hoisted.previewPrompt } },
  isKernelMode: () => true,
  // The kernel plane never reaches the legacy raw surface: a call here means
  // the preview fell through to the sidecar path.
  closedBackendGuard: () => {
    throw new Error('no legacy transport may be reached on the kernel plane');
  },
}));

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

const CHAT_ID = '018f0000-0000-7000-8000-000000000302';

function plannedPreview(request: ChatPromptPreviewRequestDto): ChatPromptPreviewResultDto {
  return {
    plan: {
      chatId: request.chatId,
      provider: 'fake',
      model: 'fake-1',
      instructFormat: 'plain-messages-v1',
      tokenizerProfile: 'heuristic-v1',
      approximateTokens: true,
      contextLimit: 8_192,
      responseReserved: 2_048,
      inputTokens: 320,
      overBudget: false,
      systemBlocks: [{ source: 'character', text: 'Aria is a cheerful guide.' }],
      messages: [
        { role: 'system', content: 'Aria is a cheerful guide.' },
        { role: 'user', content: request.userMessage },
      ],
      excluded: [],
      createdAt: '2026-08-13T00:00:00Z',
    },
  };
}

interface HookProps {
  source: ConversationContextPreviewSource;
  draft: string;
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = createQueryClient();
  queryClient.setQueryData(['settings'], settings);
  hoisted.previewPrompt.mockReset();
  hoisted.previewPrompt.mockImplementation(async (request: ChatPromptPreviewRequestDto) =>
    plannedPreview(request),
  );
  hoisted.fetchSpy.mockReset();
  vi.stubGlobal('fetch', hoisted.fetchSpy);
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useConversationContextPreview (kernel plane)', () => {
  it('meters an existing chat through chats.prompt.preview and never the legacy route', async () => {
    const source: ConversationContextPreviewSource = {
      chatId: CHAT_ID,
      messages: [],
      historyVersion: 1,
    };
    const { result } = renderHook<ReturnType<typeof useConversationContextPreview>, HookProps>(
      ({ source: hookSource, draft }) =>
        useConversationContextPreview({ source: hookSource, draft }),
      {
        initialProps: { source, draft: 'Draft question' },
        wrapper: wrapperFor(queryClient),
      },
    );

    await waitFor(() => expect(result.current.contextUsage.isExact).toBe(true));

    expect(hoisted.previewPrompt).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      userMessage: 'Draft question',
    });
    expect(result.current.isError).toBe(false);
    expect(result.current.contextUsage).toMatchObject({
      isExact: true,
      promptTokens: 320,
      contextLimit: 8_192,
      reservedForReply: 2_048,
    });
    expect(result.current.preview).toEqual({
      tokenizer: { profile: 'heuristic-v1', approximate: true },
    });
    expect(hoisted.fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the labeled local estimate for a new chat (no kernel counterpart)', async () => {
    const source: ConversationContextPreviewSource = {
      characterId: '018f0000-0000-7000-8000-000000000301',
      greeting: 'Welcome to the orchard.',
    };
    const { result } = renderHook<ReturnType<typeof useConversationContextPreview>, HookProps>(
      ({ source: hookSource, draft }) =>
        useConversationContextPreview({ source: hookSource, draft }),
      {
        initialProps: { source, draft: 'Hello' },
        wrapper: wrapperFor(queryClient),
      },
    );

    await waitFor(() => expect(result.current.triggerPending).toBe(false));

    expect(hoisted.previewPrompt).not.toHaveBeenCalled();
    expect(hoisted.fetchSpy).not.toHaveBeenCalled();
    expect(result.current.isError).toBe(false);
    expect(result.current.preview).toBeNull();
    expect(result.current.contextUsage.isExact).toBe(false);
  });
});
