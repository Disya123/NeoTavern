import type { PromptContextAudit, PromptPreviewDto } from '@neotavern/contracts';
import { estimateTokens } from '@neotavern/shared';
import { describe, expect, it } from 'vitest';
import { summarizeContextUsage, summarizePlanUsage } from './contextUsage.js';

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

describe('summarizePlanUsage', () => {
  const characterText = 'Aria is a cheerful guide.';
  const loreText = 'Sword lore.';
  const personaText = 'The user is Ada.';
  const userText = 'Hello there';

  function plan(overrides: Partial<PromptPreviewDto> = {}): PromptPreviewDto {
    return {
      chatId: '018f0000-0000-7000-8000-000000000212',
      provider: 'fake',
      model: 'fake-1',
      instructFormat: 'plain-messages-v1',
      tokenizerProfile: 'heuristic-v1',
      approximateTokens: true,
      contextLimit: 4096,
      responseReserved: 1024,
      inputTokens: 100,
      overBudget: false,
      systemBlocks: [
        { source: 'character', text: characterText },
        { source: 'lorebook', text: loreText },
        { source: 'persona', text: personaText },
        { source: 'memory', text: 'The city sleeps.' },
      ],
      messages: [
        { role: 'system', content: `${characterText}\n\n${loreText}` },
        { role: 'user', content: 'Earlier question' },
        { role: 'user', content: userText },
      ],
      excluded: [{ messageId: '018f0000-0000-7000-8000-000000000213', reason: 'token_budget' }],
      createdAt: '2026-08-13T00:00:00Z',
      ...overrides,
    };
  }

  it('splits the kernel plan by block source and keeps the budget authoritative', () => {
    const source = plan();
    const summary = summarizePlanUsage(source);

    const attributed =
      estimateTokens(characterText) +
      estimateTokens(loreText) +
      estimateTokens(personaText) +
      estimateTokens('The city sleeps.') +
      estimateTokens('Earlier question') +
      estimateTokens(userText);

    expect(summary).toMatchObject({
      isExact: true,
      promptTokens: source.inputTokens,
      contextLimit: source.contextLimit,
      reservedForReply: source.responseReserved,
      breakdown: {
        character: estimateTokens(characterText),
        worldInfo: estimateTokens(loreText),
        persona: estimateTokens(personaText),
        chatHistory: estimateTokens('Earlier question') + estimateTokens(userText),
        // Memory blocks and the estimator's per-message overhead stay visible
        // under `other`; the parts always add up to the pipeline's own budget.
        other: Math.max(0, source.inputTokens - attributed) + estimateTokens('The city sleeps.'),
      },
    });
    const parts = Object.values(summary.breakdown).reduce((sum, tokens) => sum + tokens, 0);
    expect(parts).toBe(source.inputTokens);
  });

  it('reports an over-budget preview without inventing free space', () => {
    const summary = summarizePlanUsage(
      plan({ contextLimit: 512, responseReserved: 128, inputTokens: 900, overBudget: true }),
    );

    expect(summary.promptTokens).toBe(900);
    expect(summary.availableTokens).toBe(0);
    expect(summary.usagePercent).toBe(100);
  });
});
