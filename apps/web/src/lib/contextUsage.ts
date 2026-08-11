/**
 * Values displayed by the compact chat context panel. Exact values are derived
 * from the last prompt audit; before a request exists, only local estimates
 * for the visible chat history and composer draft are available.
 */
import type { PromptContextAudit, PromptContextAuditEntry } from '@neotavern/contracts';

export type PromptContextUsageSource = Pick<PromptContextAudit, 'budget' | 'entries'>;

export interface ContextUsageFallback {
  contextLimit: number;
  reservedForReply: number;
  historyTokens: number;
  draftTokens: number;
}

export interface ContextUsageBreakdown {
  chatHistory: number;
  worldInfo: number;
  character: number;
  persona: number;
  other: number;
}

export interface ContextUsageSummary {
  isExact: boolean;
  promptTokens: number;
  contextLimit: number;
  reservedForReply: number;
  availableTokens: number;
  usagePercent: number;
  breakdown: ContextUsageBreakdown;
}

/**
 * Summarize the actual context submitted to a provider by stable pipeline
 * identifiers and sources. Excluded entries never contribute to the display.
 */
export function summarizeContextUsage(
  audit: PromptContextUsageSource | null,
  fallback: ContextUsageFallback,
): ContextUsageSummary {
  if (!audit) {
    const promptTokens = Math.max(0, fallback.historyTokens) + Math.max(0, fallback.draftTokens);
    return buildSummary({
      isExact: false,
      promptTokens,
      contextLimit: fallback.contextLimit,
      reservedForReply: fallback.reservedForReply,
      breakdown: {
        chatHistory: promptTokens,
        worldInfo: 0,
        character: 0,
        persona: 0,
        other: 0,
      },
    });
  }

  const breakdown: ContextUsageBreakdown = {
    chatHistory: 0,
    worldInfo: 0,
    character: 0,
    persona: 0,
    other: 0,
  };

  for (const entry of audit.entries) {
    if (!entry.included) continue;
    breakdown[categoryForEntry(entry)] += entry.tokens;
  }

  const auditedEntryTokens = Object.values(breakdown).reduce((sum, tokens) => sum + tokens, 0);
  // The budget is authoritative. Keep any serialization/tokenizer delta
  // visible instead of inflating a character or lorebook category.
  breakdown.other += Math.max(0, audit.budget.promptTokens - auditedEntryTokens);

  return buildSummary({
    isExact: true,
    promptTokens: audit.budget.promptTokens,
    contextLimit: audit.budget.contextLimit,
    reservedForReply: audit.budget.reservedForReply,
    breakdown,
  });
}

function buildSummary(
  input: Omit<ContextUsageSummary, 'availableTokens' | 'usagePercent'>,
): ContextUsageSummary {
  const contextLimit = Math.max(1, input.contextLimit);
  const reservedForReply = Math.max(0, input.reservedForReply);
  const promptTokens = Math.max(0, input.promptTokens);
  return {
    ...input,
    contextLimit,
    reservedForReply,
    promptTokens,
    availableTokens: Math.max(0, contextLimit - reservedForReply - promptTokens),
    usagePercent: Math.min(
      100,
      Math.max(0, Math.round(((promptTokens + reservedForReply) / contextLimit) * 100)),
    ),
  };
}

function categoryForEntry(entry: PromptContextAuditEntry): keyof ContextUsageBreakdown {
  if (entry.source === 'lorebook') return 'worldInfo';
  if (entry.identifier === 'core.persona') return 'persona';
  if (entry.source === 'history' || entry.source === 'user') return 'chatHistory';
  if (
    entry.identifier === 'core.character-description' ||
    entry.identifier === 'core.character-personality' ||
    entry.identifier === 'core.scenario' ||
    entry.identifier === 'core.dialogue-examples' ||
    entry.identifier === 'core.character-post-history-instructions'
  ) {
    return 'character';
  }
  return 'other';
}
