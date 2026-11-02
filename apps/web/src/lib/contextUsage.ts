/**
 * Values displayed by the compact chat context panel. Exact values are derived
 * from the last prompt audit; before a request exists, only local estimates
 * for the visible chat history and composer draft are available.
 */
import type {
  PromptContextAudit,
  PromptContextAuditEntry,
  PromptPreviewDto,
} from '@neotavern/contracts';
import { estimateTokens } from '@neotavern/shared';

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

/** System-block sources the kernel planner emits (one per stage). */
const KERNEL_BLOCK_SOURCES: Readonly<Record<string, keyof ContextUsageBreakdown>> = {
  character: 'character',
  persona: 'persona',
  lorebook: 'worldInfo',
};

/**
 * Summarize the KERNEL prompt preview (`wire.prompt.preview`, M7 Etap-4
 * cluster 17 part 2). The kernel plan reports the pipeline's own token budget
 * (`inputTokens`) plus the concrete blocks and messages that entered it — it
 * has no per-entry token ledger like the legacy audit, so the breakdown is
 * split by block source with the same local estimator the kernel uses, and
 * everything the estimator cannot attribute stays visible under `other`
 * (never inflated into a character or lorebook row). The budget remains
 * authoritative, exactly like `summarizeContextUsage`.
 */
export function summarizePlanUsage(plan: PromptPreviewDto): ContextUsageSummary {
  const breakdown: ContextUsageBreakdown = {
    chatHistory: 0,
    worldInfo: 0,
    character: 0,
    persona: 0,
    other: 0,
  };
  for (const block of plan.systemBlocks) {
    breakdown[KERNEL_BLOCK_SOURCES[block.source] ?? 'other'] += estimateTokens(block.text);
  }
  for (const message of plan.messages) {
    if (message.role === 'system') continue;
    breakdown.chatHistory += estimateTokens(message.content);
  }
  const attributed = Object.values(breakdown).reduce((sum, tokens) => sum + tokens, 0);
  breakdown.other += Math.max(0, plan.inputTokens - attributed);

  return buildSummary({
    isExact: true,
    promptTokens: plan.inputTokens,
    contextLimit: plan.contextLimit,
    reservedForReply: plan.responseReserved,
    breakdown,
  });
}
