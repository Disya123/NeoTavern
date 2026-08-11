/**
 * Context shifting (ТЗ §10 / AGENTS.md §10). Fits the conversation into a token
 * budget before the request: system messages, pinned messages and (as much as
 * possible) the most recent turns are protected; the oldest unprotected blocks
 * are dropped. Tool-call / tool-result messages are removed as linked pairs.
 *
 * Built-in strategies: `truncate`, `summarize`, `vector-recall` and `manual`.
 * Plugins may add strategies through the registry, but the pipeline still
 * applies a final host-controlled budget check.
 */
import type { MessageRole } from '@neotavern/contracts';

export interface PromptMessage {
  /** Stable source message/block id used by diagnostics and manual strategies. */
  id?: string;
  role: MessageRole;
  content: string;
  name?: string;
  pinned?: boolean;
  /** Links an assistant tool call to its tool result even when they are not adjacent. */
  pairId?: string;
  source?: 'system' | 'history' | 'user' | 'lorebook' | 'memory' | 'plugin' | 'template';
  /** Relevance score supplied by Lorebook/Memory retrieval (higher is better). */
  relevance?: number;
}

export interface ContextShiftResult {
  kept: PromptMessage[];
  excluded: PromptMessage[];
  estimatedTokens: number;
  truncated: boolean;
  /** False when protected context alone exceeds the available budget. */
  fitsBudget: boolean;
}

export interface ContextShiftOptions {
  /** Reserved tokens for the model reply. */
  reserveForReply?: number;
  /** Overhead tokens counted per message (role/separators). */
  perMessageOverhead?: number;
  /** Lower values are removed first; omitted means original oldest-first order. */
  removalPriority?: (message: PromptMessage, index: number) => number;
}

export type TokenCounter = (text: string) => number | Promise<number>;

export async function shiftContext(
  messages: PromptMessage[],
  countTokens: TokenCounter,
  budgetTokens: number,
  options: ContextShiftOptions = {},
): Promise<ContextShiftResult> {
  const overhead = options.perMessageOverhead ?? 4;
  const cost = async (m: PromptMessage): Promise<number> =>
    (await countTokens(m.content)) + overhead;

  const totalFor = async (items: PromptMessage[]): Promise<number> => {
    const costs = await Promise.all(items.map(cost));
    return costs.reduce((sum, item) => sum + item, 0);
  };
  let total = await totalFor(messages);
  const removable = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => !isProtectedMessage(message))
    .sort(
      (left, right) =>
        (options.removalPriority?.(left.message, left.index) ?? left.index) -
        (options.removalPriority?.(right.message, right.index) ?? right.index),
    )
    .map(({ message }) => message);
  const excluded: PromptMessage[] = [];
  const removed = new Set<PromptMessage>();

  const remove = (m: PromptMessage): void => {
    if (removed.has(m)) return;
    removed.add(m);
    excluded.push(m);
  };

  // Drop oldest-first. Tool messages are dropped with their linked call/result
  // group. A group containing a pinned message is protected as a whole.
  for (const message of removable) {
    if (total <= budgetTokens) break;
    const group = linkedToolMessages(messages, message);
    if (group.some(isProtectedMessage)) {
      continue;
    }
    for (const candidate of group) {
      remove(candidate);
    }
    // Recalculate after every mutation group. Tokenizer implementations are
    // allowed to include per-message accounting that is not safely subtractive.
    total = await totalFor(messages.filter((candidate) => !removed.has(candidate)));
  }

  const kept = messages.filter((m) => !removed.has(m));
  total = await totalFor(kept);
  return {
    kept,
    excluded,
    estimatedTokens: total,
    truncated: excluded.length > 0,
    fitsBudget: total <= budgetTokens,
  };
}

export type BuiltinContextStrategyId = 'truncate' | 'summarize' | 'vector-recall' | 'manual';

export interface ContextStrategyRequest {
  messages: PromptMessage[];
  countTokens: TokenCounter;
  budgetTokens: number;
  /** Message ids selected by the user for exclusion in manual mode. */
  manualExcludedIds?: ReadonlySet<string>;
}

export interface ContextShiftStrategy {
  readonly id: string;
  readonly priority?: number;
  shift(request: ContextStrategyRequest): ContextShiftResult | Promise<ContextShiftResult>;
}

/**
 * Registry used by core and plugins. Higher-priority registrations override a
 * strategy with the same id and cleanup restores the previous implementation.
 */
export class ContextStrategyRegistry {
  private readonly strategies = new Map<string, ContextShiftStrategy[]>();

  constructor(registerBuiltins = true) {
    if (registerBuiltins) {
      this.register(truncateStrategy);
      this.register(summarizeStrategy);
      this.register(vectorRecallStrategy);
      this.register(manualStrategy);
    }
  }

  register(strategy: ContextShiftStrategy): () => void {
    if (strategy.id.trim().length === 0) {
      throw new Error('Context strategy id must not be empty');
    }
    const versions = this.strategies.get(strategy.id) ?? [];
    versions.push(strategy);
    versions.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
    this.strategies.set(strategy.id, versions);
    return () => {
      const current = this.strategies.get(strategy.id);
      if (!current) return;
      const index = current.indexOf(strategy);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.strategies.delete(strategy.id);
    };
  }

  resolve(id: string): ContextShiftStrategy {
    const strategy = this.strategies.get(id)?.[0];
    if (!strategy) throw new Error(`Unknown context strategy "${id}"`);
    return strategy;
  }

  ids(): string[] {
    return [...this.strategies.keys()].sort();
  }
}

const truncateStrategy: ContextShiftStrategy = {
  id: 'truncate',
  shift: async ({ messages, countTokens, budgetTokens }) =>
    withStrategy(await shiftContext(messages, countTokens, budgetTokens), 'truncate'),
};

const summarizeStrategy: ContextShiftStrategy = {
  id: 'summarize',
  shift: async ({ messages, countTokens, budgetTokens }) => {
    const truncated = await shiftContext(messages, countTokens, budgetTokens);
    if (truncated.excluded.length === 0) return withStrategy(truncated, 'summarize');

    const summary = await buildExtractiveSummary(
      truncated.excluded,
      countTokens,
      Math.max(8, Math.min(128, Math.floor(budgetTokens * 0.35))),
    );
    const currentUserIndex = truncated.kept.findIndex((message) => message.source === 'user');
    const insertionIndex = currentUserIndex < 0 ? truncated.kept.length : currentUserIndex;
    const withSummary = [...truncated.kept];
    const summaryMessage: PromptMessage = {
      id: 'core.context-summary',
      role: 'system',
      content: summary,
      source: 'memory',
      relevance: 1,
    };
    withSummary.splice(insertionIndex, 0, summaryMessage);
    const fitted = await shiftContext(withSummary, countTokens, budgetTokens, {
      removalPriority: (message, index) =>
        message.id === summaryMessage.id ? Number.MAX_SAFE_INTEGER - 1 : index,
    });
    const excluded = dedupeMessages([
      ...truncated.excluded,
      ...fitted.excluded.filter((message) => message.id !== summaryMessage.id),
    ]);
    return {
      ...fitted,
      excluded,
      truncated: excluded.length > 0,
      strategy: 'summarize',
      summaryCreated: fitted.kept.some((message) => message.id === summaryMessage.id),
    };
  },
};

const vectorRecallStrategy: ContextShiftStrategy = {
  id: 'vector-recall',
  shift: async ({ messages, countTokens, budgetTokens }) =>
    withStrategy(
      await shiftContext(messages, countTokens, budgetTokens, {
        removalPriority: (message, index) => {
          if (message.source === 'memory' || message.source === 'lorebook') {
            const relevance = Number.isFinite(message.relevance) ? (message.relevance ?? 0) : 0;
            return Math.max(0, Math.min(1, relevance)) * 10_000;
          }
          // Optional retrieved blocks are discarded before recent history.
          return 20_000 + index;
        },
      }),
      'vector-recall',
    ),
};

const manualStrategy: ContextShiftStrategy = {
  id: 'manual',
  shift: async ({ messages, countTokens, budgetTokens, manualExcludedIds }) => {
    const selected = manualExcludedIds ?? new Set<string>();
    const manualSet = new Set<PromptMessage>();
    for (const message of messages) {
      if (message.id === undefined || !selected.has(message.id)) continue;
      for (const linked of linkedToolMessages(messages, message)) {
        if (!isProtectedMessage(linked)) manualSet.add(linked);
      }
    }
    const manuallyExcluded = messages.filter((message) => manualSet.has(message));
    const excludedSet = new Set(manuallyExcluded);
    const remaining = messages.filter((message) => !excludedSet.has(message));
    const fitted = await shiftContext(remaining, countTokens, budgetTokens);
    const excluded = dedupeMessages([...manuallyExcluded, ...fitted.excluded]);
    return {
      ...fitted,
      excluded,
      truncated: excluded.length > 0,
      strategy: 'manual',
      manualFallback: fitted.excluded.length > 0,
    };
  },
};

export interface ContextShiftResult {
  /** Strategy that produced this result, when invoked through the registry. */
  strategy?: string;
  /** True when summarize retained a generated summary block. */
  summaryCreated?: boolean;
  /** True when manual selections were insufficient and safe truncation continued. */
  manualFallback?: boolean;
}

function withStrategy(result: ContextShiftResult, strategy: string): ContextShiftResult {
  return { ...result, strategy };
}

function isProtectedMessage(message: PromptMessage): boolean {
  return (
    message.pinned === true ||
    (message.role === 'system' && (message.source === undefined || message.source === 'system'))
  );
}

function linkedToolMessages(messages: PromptMessage[], message: PromptMessage): PromptMessage[] {
  if (message.pairId) {
    return messages.filter(
      (candidate) =>
        candidate.pairId === message.pairId &&
        (candidate.role === 'assistant' || candidate.role === 'tool'),
    );
  }

  const index = messages.indexOf(message);
  if (message.role === 'tool') {
    const previous = messages[index - 1];
    return previous?.role === 'assistant' ? [previous, message] : [message];
  }
  if (message.role === 'assistant') {
    const next = messages[index + 1];
    return next?.role === 'tool' ? [message, next] : [message];
  }
  return [message];
}

async function buildExtractiveSummary(
  messages: PromptMessage[],
  countTokens: TokenCounter,
  targetTokens: number,
): Promise<string> {
  const lines = messages.map((message) => {
    const normalized = message.content.replace(/\s+/g, ' ').trim();
    const excerpt =
      normalized.length <= 160
        ? normalized
        : `${normalized.slice(0, 104)} … ${normalized.slice(-40)}`;
    return `${message.role}: ${excerpt}`;
  });
  const prefix = '[Summary of earlier context]\n';
  let body = lines.join('\n');
  let summary = `${prefix}${body}`;
  while ((await countTokens(summary)) > targetTokens && body.length > 24) {
    body = `${body.slice(0, Math.max(24, Math.floor(body.length * 0.72))).trimEnd()}…`;
    summary = `${prefix}${body}`;
  }
  return summary;
}

function dedupeMessages(messages: PromptMessage[]): PromptMessage[] {
  return [...new Set(messages)];
}
