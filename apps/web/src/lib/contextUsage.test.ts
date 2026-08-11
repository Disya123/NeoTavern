import type { PromptContextAudit } from '@neotavern/contracts';
import { describe, expect, it } from 'vitest';
import { summarizeContextUsage } from './contextUsage.js';

function audit(entries: PromptContextAudit['entries']): PromptContextAudit {
  return {
    generationId: '018f0000-0000-7000-8000-000000000211',
    chatId: '018f0000-0000-7000-8000-000000000212',
    providerConfigId: null,
    providerKind: 'echo',
    providerSource: null,
    model: 'echo',
    createdAt: 1_700_000_000_000,
    status: 'completed',
    errorCode: null,
    chatTemplateId: null,
    promptTemplateId: null,
    promptTemplateMode: 'chat',
    tokenizer: { profile: 'test:exact', approximate: false },
    budget: { contextLimit: 512, reservedForReply: 64, promptTokens: 153 },
    contextStrategy: 'truncate',
    entries,
    providerMessages: [],
    diagnostics: [],
    usage: null,
  };
}

describe('summarizeContextUsage', () => {
  it('uses included audit entries instead of fabricated character and lorebook values', () => {
    const summary = summarizeContextUsage(
      audit([
        entry('message-1', 'history', 50),
        entry('core.current-user-input', 'user', 10),
        entry('lore.eldoria', 'lorebook', 33),
        entry('core.character-description', 'system', 17),
        entry('core.character-post-history-instructions', 'system', 6),
        entry('core.persona', 'system', 13),
        entry('core.main-prompt', 'system', 21),
        entry('memory.1', 'memory', 9, false),
      ]),
      { contextLimit: 1, reservedForReply: 0, historyTokens: 0, draftTokens: 0 },
    );

    expect(summary).toMatchObject({
      isExact: true,
      promptTokens: 153,
      contextLimit: 512,
      reservedForReply: 64,
      availableTokens: 295,
      usagePercent: 42,
      breakdown: {
        chatHistory: 60,
        worldInfo: 33,
        character: 23,
        persona: 13,
        other: 24,
      },
    });
  });

  it('shows only a clearly limited local estimate before the first audit', () => {
    const summary = summarizeContextUsage(null, {
      contextLimit: 200,
      reservedForReply: 40,
      historyTokens: 25,
      draftTokens: 15,
    });

    expect(summary).toMatchObject({
      isExact: false,
      promptTokens: 40,
      availableTokens: 120,
      usagePercent: 40,
      breakdown: {
        chatHistory: 40,
        worldInfo: 0,
        character: 0,
        persona: 0,
        other: 0,
      },
    });
  });
});

function entry(
  identifier: string,
  source: string,
  tokens: number,
  included = true,
): PromptContextAudit['entries'][number] {
  return {
    identifier,
    role: 'system',
    source,
    content: identifier,
    tokens,
    included,
    exclusionReason: included ? 'none' : 'disabled',
    order: 0,
  };
}
