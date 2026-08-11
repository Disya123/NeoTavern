/**
 * Prompt pipeline with a fixed, observable stage order:
 *
 * User input -> Macros -> Character/persona -> Lorebook -> Memory/RAG ->
 * Token counting -> Context shifting -> Plugin interceptors ->
 * Final budget enforcement -> Instruct rendering -> Provider request.
 */
import type {
  Character,
  CorePromptBlockId,
  CustomInstructFormat,
  GenerationMessage,
  GenerationRequest,
  Message,
  PromptBlockSettings,
  PromptContextAuditEntry,
  PromptPostProcessingMode,
  PromptTemplate,
  PromptTriggerId,
  Persona,
} from '@neotavern/contracts';
import {
  DEFAULT_PROMPT_TEMPLATE,
  PromptBlockIds,
  TextAdapterKinds,
  hasRequiredPromptBlocks,
  isCorePromptBlockId,
  normalizePromptBlockOrder,
} from '@neotavern/contracts';
import { estimateTokens } from '@neotavern/provider-sdk';
import { AppError, ErrorCodes, withTimeout } from '@neotavern/shared';
import {
  shiftContext,
  type ContextShiftResult,
  type ContextShiftStrategy,
  type PromptMessage,
  type TokenCounter,
} from './contextShift.js';
import { getInstructFormat, renderInstruct } from './instruct.js';
import { replaceMacros, type MacroContext } from './macros.js';
import { buildPromptAuditEntries, type PromptAuditJournalItem } from './promptAudit.js';
import { postProcessMessages, type PromptPostProcessingNames } from './promptPostProcessing.js';

export interface PipelineInterceptor {
  id: string;
  priority?: number;
  timeoutMs?: number;
  /**
   * Permission required to run this hook (ТЗ §4.4 «доступные права»). The host
   * verifies it via {@link PipelineInput.hasPermission}; a missing permission
   * skips the interceptor with a diagnostics entry instead of failing the run.
   */
  requiredPermission?: string;
  intercept(context: {
    messages: PromptMessage[];
    meta: Record<string, unknown>;
    /** Generation abort signal (ТЗ §4.4 «возможность отмены»). */
    signal?: AbortSignal;
  }): Promise<{ messages: PromptMessage[] }> | { messages: PromptMessage[] };
}

export interface PipelineContextBlock {
  id: string;
  source: 'lorebook' | 'memory';
  /** Lorebook placement inside an ordered text-completion template. */
  placement?: 'before' | 'after';
  content: string;
  /** Required blocks survive shifting and can make the request fail safely. */
  required?: boolean;
  /** Retrieval relevance in the inclusive 0..1 range. */
  relevance?: number;
}

interface PromptAssembly {
  messages: PromptMessage[];
  journal: PromptAuditJournalItem[];
}

export interface PipelineInput {
  character: Character | null;
  persona: Persona | null;
  /** Lorebook and Memory/RAG results, already ranked by their source modules. */
  contextBlocks?: PipelineContextBlock[];
  /** Recent history in ascending (oldest -> newest) order. */
  history: Message[];
  userInput?: string;
  model: string;
  maxContextTokens?: number;
  reserveForReply?: number;
  instructFormatId?: string;
  /** User-authored instruct format. Takes precedence over a built-in format id. */
  instructFormat?: CustomInstructFormat | null;
  /** Chat-native or ordered text-completion prompt assembly settings. */
  promptTemplate?: PromptTemplate;
  /** Generation action used by prompt-manager trigger filters. */
  generationType?: PromptTriggerId;
  generationOverrides?: Partial<GenerationRequest>;
  /** Additional stop sequences from the active connection profile. */
  connectionStopStrings?: readonly string[];
  /** Assistant-turn prefix from the active connection profile. */
  assistantPrefill?: string;
  /**
   * Built-in provider kind driving this generation. Text-completion kinds
   * (`text-completion`, `novelai`, `ai-horde`, `koboldai`) always serialize the
   * rendered instruct prompt as text instead of a structured message array.
   */
  providerKind?: string;
  /**
   * SillyTavern-style prompt post-processing applied to the structured message
   * array in chat mode (`serializeAsText=false`): merge/semi/strict/single and
   * their `_tools` variants. Ignored when the prompt is serialized as text.
   */
  promptPostProcessing?: PromptPostProcessingMode;
  /** Character/user display names used by post-processing name prefixing. */
  promptNames?: PromptPostProcessingNames;
  interceptors?: PipelineInterceptor[];
  /**
   * Host-provided permission checker for interceptor hooks (ТЗ §4.4). Interceptors
   * declaring `requiredPermission` are skipped unless this returns true. When
   * omitted, interceptors are trusted (host-owned paths that already enforce
   * permissions at registration time).
   */
  hasPermission?: (permission: string) => boolean;
  /** Local tokenizer selected for the model. Defaults to an explicit approximation. */
  countTokens?: TokenCounter;
  tokenizerProfile?: string;
  tokenizerApproximate?: boolean;
  contextStrategy?: ContextShiftStrategy;
  /** Explicit message ids excluded by the user when manual strategy is active. */
  manualExcludedIds?: ReadonlySet<string>;
  /** Generation abort signal — assembly checkpoints and hooks honor it (ТЗ §4.4). */
  signal?: AbortSignal;
  /** User-defined macro variables (settings `macroVariables`). */
  variables?: Record<string, string>;
  /** Injectable clock for time macros (deterministic tests). */
  now?: Date;
  /** Where persona description is injected into the assembled prompt. */
  personaPlacement?: 'persona' | 'authors-note-top' | 'authors-note-bottom' | 'in-chat';
}

export interface PipelineResult {
  messages: GenerationMessage[];
  instructPrompt: string;
  request: GenerationRequest;
  excludedCount: number;
  diagnostics: string[];
  auditEntries: PromptContextAuditEntry[];
  tokenBudget: {
    profile: string;
    approximate: boolean;
    contextLimit: number;
    reservedForReply: number;
    promptTokens: number;
  };
  contextStrategy: string;
}

export async function runPromptPipeline(input: PipelineInput): Promise<PipelineResult> {
  const diagnostics: string[] = [];
  const ensureNotAborted = (): void => {
    if (input.signal?.aborted) {
      throw new AppError({
        code: ErrorCodes.GENERATION_CANCELLED,
        message: 'Generation aborted during prompt assembly',
      });
    }
  };
  const countTokens = input.countTokens ?? estimateTokens;
  const tokenizerProfile = input.tokenizerProfile ?? 'approximate-character-v1';
  const tokenizerApproximate = input.tokenizerApproximate ?? input.countTokens === undefined;
  const contextLimit = input.maxContextTokens ?? 8192;
  const overrides = input.generationOverrides ?? {};
  const requestedMaxTokens = overrides.maxTokens ?? input.reserveForReply ?? 1024;
  const reserve = Math.max(input.reserveForReply ?? 0, requestedMaxTokens);
  const promptBudget = contextLimit - reserve;
  if (promptBudget <= 0) {
    throw tokenBudgetError(contextLimit, reserve, 0);
  }

  const macros: MacroContext = {
    userName: input.persona?.name ?? 'User',
    charName: input.character?.name ?? 'Assistant',
    variables: input.variables,
    now: input.now,
  };
  const manualExcludedIds =
    input.manualExcludedIds ??
    new Set(
      input.history
        .filter((message) => message.meta['manualExcluded'] === true)
        .map((message) => message.id),
    );

  const assembly = assemblePromptMessages(input, macros);
  const raw = assembly.messages;

  diagnostics.push(`assembled ${raw.length} message(s)`);
  diagnostics.push(
    tokenizerApproximate
      ? `tokenizer "${tokenizerProfile}" is approximate`
      : `tokenizer "${tokenizerProfile}" selected`,
  );

  // Enforce the budget at the documented stage before plugin interceptors.
  ensureNotAborted();
  const strategy = input.contextStrategy;
  let strategyResult = strategy
    ? await runContextStrategy(strategy, raw, countTokens, promptBudget, manualExcludedIds)
    : await shiftContext(raw, countTokens, promptBudget);
  if (strategy && strategyResult.strategy === 'truncate' && strategy.id !== 'truncate') {
    diagnostics.push(
      `context strategy "${strategy.id}" failed or timed out; safe truncation used instead`,
    );
  }
  const protectedById = new Map(
    raw
      .filter(
        (message): message is PromptMessage & { id: string } =>
          message.id !== undefined &&
          (message.pinned === true || (message.role === 'system' && message.source === 'system')),
      )
      .map((message) => [message.id, message]),
  );
  const returnedIds = new Set(
    strategyResult.kept.map((message) => message.id).filter((id): id is string => id !== undefined),
  );
  if ([...protectedById.keys()].some((id) => !returnedIds.has(id))) {
    diagnostics.push(
      `context strategy "${strategyResult.strategy ?? strategy?.id ?? 'unknown'}" rejected: protected context was removed`,
    );
    strategyResult = {
      ...(await shiftContext(raw, countTokens, promptBudget)),
      strategy: 'truncate',
    };
  }
  const sanitizedStrategyMessages = dedupePromptMessages(
    strategyResult.kept.map((message) =>
      message.id ? (protectedById.get(message.id) ?? message) : message,
    ),
  );
  const hostChecked = await shiftContext(sanitizedStrategyMessages, countTokens, promptBudget);
  const initialShift = {
    ...hostChecked,
    excluded: dedupePromptMessages([...strategyResult.excluded, ...hostChecked.excluded]),
    truncated: strategyResult.truncated || hostChecked.truncated,
    strategy: strategyResult.strategy ?? strategy?.id ?? 'truncate',
    summaryCreated: strategyResult.summaryCreated,
    manualFallback: strategyResult.manualFallback,
  };
  ensureFitsBudget(initialShift.estimatedTokens, initialShift.fitsBudget, contextLimit, reserve);
  diagnostics.push(`context strategy "${initialShift.strategy ?? 'truncate'}" applied`);
  if (initialShift.truncated) {
    diagnostics.push(
      `context shift excluded ${initialShift.excluded.length} message(s) before interceptors`,
    );
  }
  if (initialShift.summaryCreated) diagnostics.push('context summary created');
  if (initialShift.manualFallback) {
    diagnostics.push('manual exclusions were insufficient; safe truncation continued');
  }

  let working = initialShift.kept;
  const hostContextById = new Map(
    initialShift.kept
      .filter((message): message is PromptMessage & { id: string } => message.id !== undefined)
      .map((message) => [message.id, message]),
  );
  const interceptors = [...(input.interceptors ?? [])].sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
  );
  for (const interceptor of interceptors) {
    ensureNotAborted();
    if (
      interceptor.requiredPermission &&
      !(input.hasPermission?.(interceptor.requiredPermission) ?? true)
    ) {
      diagnostics.push(
        `interceptor "${interceptor.id}" skipped (missing permission "${interceptor.requiredPermission}")`,
      );
      continue;
    }
    const before = working;
    try {
      const result = await withTimeout(
        Promise.resolve(
          interceptor.intercept({ messages: working, meta: {}, signal: input.signal }),
        ),
        interceptor.timeoutMs ?? 2000,
        input.signal,
      );
      working = result.messages.map((message) => ({
        ...message,
        // Plugin-added messages are always optional. Existing host blocks keep
        // their host-assigned protection flags even if a plugin edits content.
        pinned: message.id ? hostContextById.get(message.id)?.pinned : false,
        source: message.id ? (hostContextById.get(message.id)?.source ?? 'plugin') : 'plugin',
      }));
      working = restoreProtectedMessages(working, initialShift.kept);
      // Prompt-change journal entry (ТЗ §4.4): what the hook actually did.
      diagnostics.push(
        `interceptor "${interceptor.id}" applied (${describePromptDiff(before, working)})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      diagnostics.push(`interceptor "${interceptor.id}" skipped (${message})`);
    }
  }

  ensureNotAborted();

  // Plugins may expand the prompt, so the final budget is mandatory.
  const finalShift = await shiftContext(working, countTokens, promptBudget);
  ensureFitsBudget(finalShift.estimatedTokens, finalShift.fitsBudget, contextLimit, reserve);
  if (finalShift.truncated) {
    diagnostics.push(`final budget enforcement excluded ${finalShift.excluded.length} message(s)`);
  }

  const messages: GenerationMessage[] = finalShift.kept.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
  }));

  const format = input.instructFormat ?? getInstructFormat(input.instructFormatId ?? 'chatml');
  const instructPrompt = renderInstruct(
    format,
    finalShift.kept.map((message) => ({
      role: message.role,
      content: message.content,
      name: message.name,
    })),
  );
  const explicitInstructFormat =
    input.instructFormat !== undefined && input.instructFormat !== null;
  const isTextKindProvider =
    input.providerKind !== undefined &&
    (TextAdapterKinds as readonly string[]).includes(input.providerKind);
  const serializeAsText =
    input.promptTemplate?.mode === 'text' ||
    explicitInstructFormat ||
    input.instructFormatId !== undefined ||
    isTextKindProvider;

  let providerMessages: GenerationMessage[];
  if (serializeAsText) {
    providerMessages = [{ role: 'user', content: instructPrompt }];
  } else {
    // Chat mode: optionally reshape the structured message array per the
    // SillyTavern-style post-processing mode before serialization.
    providerMessages = postProcessMessages(messages, input.promptPostProcessing, input.promptNames);
    if (input.promptPostProcessing && input.promptPostProcessing.length > 0) {
      diagnostics.push(`prompt post-processing "${input.promptPostProcessing}" applied`);
    }
  }

  if (input.promptTemplate?.mode === 'text') {
    diagnostics.push('ordered text-completion prompt template applied');
  } else if (explicitInstructFormat) {
    diagnostics.push(`custom instruct format "${input.instructFormat?.id}" applied`);
  } else if (input.instructFormatId !== undefined) {
    diagnostics.push(`built-in instruct format "${input.instructFormatId}" applied`);
  } else if (isTextKindProvider) {
    diagnostics.push('text-completion provider serialized the instruct prompt as text');
  } else {
    diagnostics.push('native chat message serialization applied');
  }

  const stop = uniqueStopStrings([
    ...(serializeAsText ? format.stopStrings : []),
    ...(input.connectionStopStrings ?? []),
    ...(overrides.stop ?? []),
  ]);
  const request: GenerationRequest = {
    model: input.model,
    messages: providerMessages,
    maxTokens: requestedMaxTokens,
    temperature: overrides.temperature ?? 1,
    stream: overrides.stream ?? true,
    ...(overrides.topP !== undefined ? { topP: overrides.topP } : {}),
    ...(overrides.topK !== undefined ? { topK: overrides.topK } : {}),
    ...(overrides.minP !== undefined ? { minP: overrides.minP } : {}),
    ...(overrides.topA !== undefined ? { topA: overrides.topA } : {}),
    ...(overrides.repetitionPenalty !== undefined
      ? { repetitionPenalty: overrides.repetitionPenalty }
      : {}),
    ...(overrides.frequencyPenalty !== undefined
      ? { frequencyPenalty: overrides.frequencyPenalty }
      : {}),
    ...(overrides.presencePenalty !== undefined
      ? { presencePenalty: overrides.presencePenalty }
      : {}),
    ...(overrides.seed !== undefined ? { seed: overrides.seed } : {}),
    ...(overrides.reasoning !== undefined ? { reasoning: overrides.reasoning } : {}),
    ...(overrides.reasoningEffort !== undefined
      ? { reasoningEffort: overrides.reasoningEffort }
      : {}),
    ...(stop.length > 0 ? { stop } : {}),
    ...(input.assistantPrefill && input.assistantPrefill.length > 0
      ? { assistantPrefill: input.assistantPrefill }
      : {}),
  };

  const auditEntries = await buildPromptAuditEntries(
    assembly.journal,
    initialShift.excluded,
    working,
    finalShift,
    manualExcludedIds,
    countTokens,
  );

  return {
    messages,
    instructPrompt,
    request,
    excludedCount: initialShift.excluded.length + finalShift.excluded.length,
    diagnostics,
    auditEntries,
    tokenBudget: {
      profile: tokenizerProfile,
      approximate: tokenizerApproximate,
      contextLimit,
      reservedForReply: reserve,
      promptTokens: finalShift.estimatedTokens,
    },
    contextStrategy: initialShift.strategy ?? 'truncate',
  };
}

/** Preserve first-occurrence ordering while eliminating duplicate stop strings. */
function uniqueStopStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/** Budget for a single context-strategy run; a hung strategy falls back. */
const STRATEGY_TIMEOUT_MS = 15_000;

/**
 * Run a (possibly plugin-provided) context strategy with a hard timeout.
 * Failure or timeout degrades to the host truncation strategy — one broken
 * plugin must not kill generation (ТЗ §4.4).
 */
async function runContextStrategy(
  strategy: ContextShiftStrategy,
  messages: PromptMessage[],
  countTokens: TokenCounter,
  budgetTokens: number,
  manualExcludedIds: ReadonlySet<string>,
): Promise<ContextShiftResult> {
  try {
    return await withTimeout(
      Promise.resolve(strategy.shift({ messages, countTokens, budgetTokens, manualExcludedIds })),
      STRATEGY_TIMEOUT_MS,
    );
  } catch {
    const fallback = await shiftContext(messages, countTokens, budgetTokens);
    return { ...fallback, strategy: 'truncate' };
  }
}

/** Compact added/removed/edited summary for the prompt-change journal. */
function describePromptDiff(before: PromptMessage[], after: PromptMessage[]): string {
  const keyOf = (message: PromptMessage, index: number): string =>
    message.id ?? `#${index}:${message.role}`;
  const beforeContent = new Map(before.map((message, index) => [keyOf(message, index), message]));
  const afterKeys = new Set(after.map((message, index) => keyOf(message, index)));
  let added = 0;
  let edited = 0;
  for (const [index, message] of after.entries()) {
    const key = keyOf(message, index);
    const previous = beforeContent.get(key);
    if (!previous) added += 1;
    else if (previous.content !== message.content) edited += 1;
  }
  const removed = before.filter((message, index) => !afterKeys.has(keyOf(message, index))).length;
  return `+${added}/-${removed}/~${edited} messages`;
}

function restoreProtectedMessages(
  candidate: PromptMessage[],
  original: PromptMessage[],
): PromptMessage[] {
  const output = [...candidate];
  const presentIds = new Set(
    output.map((message) => message.id).filter((id): id is string => id !== undefined),
  );
  for (const protectedMessage of original) {
    if (
      !protectedMessage.id ||
      presentIds.has(protectedMessage.id) ||
      !(
        protectedMessage.pinned === true ||
        (protectedMessage.role === 'system' && protectedMessage.source === 'system')
      )
    ) {
      continue;
    }
    const originalIndex = original.indexOf(protectedMessage);
    const nextId = original
      .slice(originalIndex + 1)
      .map((message) => message.id)
      .find((id): id is string => id !== undefined && presentIds.has(id));
    const insertionIndex = nextId
      ? output.findIndex((message) => message.id === nextId)
      : output.length;
    output.splice(insertionIndex < 0 ? output.length : insertionIndex, 0, protectedMessage);
    presentIds.add(protectedMessage.id);
  }
  return output;
}

function dedupePromptMessages(messages: PromptMessage[]): PromptMessage[] {
  const seenIds = new Set<string>();
  const seenObjects = new Set<PromptMessage>();
  return messages.filter((message) => {
    if (message.id) {
      if (seenIds.has(message.id)) return false;
      seenIds.add(message.id);
      return true;
    }
    if (seenObjects.has(message)) return false;
    seenObjects.add(message);
    return true;
  });
}

function readPairId(meta: Record<string, unknown>): string | undefined {
  for (const key of ['toolCallId', 'tool_call_id', 'callId']) {
    const value = meta[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function ensureFitsBudget(
  promptTokens: number,
  fitsBudget: boolean,
  contextLimit: number,
  reserve: number,
): void {
  if (!fitsBudget) throw tokenBudgetError(contextLimit, reserve, promptTokens);
}

function tokenBudgetError(
  contextLimit: number,
  reservedForReply: number,
  promptTokens: number,
): AppError {
  return new AppError({
    code: ErrorCodes.TOKEN_BUDGET_EXCEEDED,
    params: { contextLimit, reservedForReply, promptTokens },
    message: 'Protected prompt context exceeds the configured token budget',
  });
}

function assemblePromptMessages(input: PipelineInput, macros: MacroContext): PromptAssembly {
  const template =
    input.promptTemplate && hasRequiredPromptBlocks(input.promptTemplate)
      ? {
          ...input.promptTemplate,
          blocks: normalizePromptBlockOrder(input.promptTemplate.blocks),
        }
      : DEFAULT_PROMPT_TEMPLATE;
  const configuredBlocks =
    template.mode === 'text' ? template.blocks : DEFAULT_PROMPT_TEMPLATE.blocks;
  const configuredById = new Map(configuredBlocks.map((block) => [block.id, block]));
  const buckets = new Map<CorePromptBlockId, PromptMessage[]>(PromptBlockIds.map((id) => [id, []]));
  const addSystemBlock = (
    blockId: CorePromptBlockId,
    id: string,
    content: string | null | undefined,
    pinned = true,
  ): void => {
    if (!content || content.trim().length === 0) return;
    buckets.get(blockId)?.push({
      id,
      role: 'system',
      content: replaceMacros(content, macros),
      pinned,
      source: 'system',
    });
  };

  if (input.character) {
    const mainBlock = configuredById.get('main-prompt');
    const defaultMainBlock = DEFAULT_PROMPT_TEMPLATE.blocks.find(
      (block) => block.id === 'main-prompt',
    );
    const configuredMainPrompt = mainBlock?.content ?? defaultMainBlock?.content;
    const characterOverride = input.character.systemPrompt?.trim();
    addSystemBlock(
      'main-prompt',
      'core.main-prompt',
      characterOverride && !mainBlock?.forbidOverrides
        ? input.character.systemPrompt
        : configuredMainPrompt,
    );
    addSystemBlock(
      'character-description',
      'core.character-description',
      input.character.description,
    );
    addSystemBlock(
      'character-personality',
      'core.character-personality',
      input.character.personality,
    );
    addSystemBlock('scenario', 'core.scenario', input.character.scenario);
    addSystemBlock('dialogue-examples', 'core.dialogue-examples', input.character.exampleDialogues);
  }

  if (input.persona && input.persona.description.trim().length > 0) {
    const personaText = `The user is ${macros.userName}: ${input.persona.description}`;
    const placement = input.personaPlacement ?? 'persona';
    if (placement === 'persona') {
      addSystemBlock('persona', 'core.persona', personaText);
    } else if (placement === 'in-chat') {
      buckets.get('chat-history')?.unshift({
        id: 'core.persona-in-chat',
        role: 'system',
        content: replaceMacros(personaText, macros),
        pinned: true,
        source: 'system',
      });
    }
  }

  for (const block of input.contextBlocks ?? []) {
    const content = replaceMacros(block.content, macros).trim();
    if (content.length === 0) continue;
    const blockId: CorePromptBlockId =
      block.source === 'memory'
        ? 'memory'
        : block.placement === 'after'
          ? 'world-info-after'
          : 'world-info-before';
    buckets.get(blockId)?.push({
      id: block.id,
      role: 'system',
      content,
      pinned: block.required === true,
      source: block.source,
      relevance: block.relevance,
    });
  }

  const latestHistoryMessage = input.history.at(-1);
  for (const message of input.history) {
    const isCurrentHistoryInput =
      input.userInput === undefined &&
      message.id === latestHistoryMessage?.id &&
      message.role === 'user';
    buckets.get('chat-history')?.push({
      id: message.id,
      role: message.role,
      content: replaceMacros(message.content, macros),
      name: message.name ?? undefined,
      pinned: message.meta['pinned'] === true || isCurrentHistoryInput,
      pairId: readPairId(message.meta),
      source: isCurrentHistoryInput ? 'user' : 'history',
    });
  }
  if (input.userInput && input.userInput.trim().length > 0) {
    buckets.get('chat-history')?.push({
      id: 'core.current-user-input',
      role: 'user',
      content: replaceMacros(input.userInput, macros),
      pinned: true,
      source: 'user',
    });
  }

  addSystemBlock(
    'post-history-instructions',
    'core.character-post-history-instructions',
    input.character?.postHistoryInstructions,
  );
  if (template.mode === 'text') {
    addSystemBlock(
      'post-history-instructions',
      'core.template-post-history-instructions',
      template.postHistoryInstructions,
    );
  }

  const authorNote =
    input.character?.ext['authors_note'] ??
    input.character?.ext['author_note'] ??
    input.character?.ext['authorsNote'];
  const personaPlacement = input.personaPlacement ?? 'persona';
  const personaDescription =
    input.persona && input.persona.description.trim().length > 0
      ? `The user is ${macros.userName}: ${input.persona.description}`
      : null;
  let mergedAuthorNote = typeof authorNote === 'string' ? authorNote : '';
  if (
    personaDescription &&
    (personaPlacement === 'authors-note-top' || personaPlacement === 'authors-note-bottom')
  ) {
    mergedAuthorNote =
      personaPlacement === 'authors-note-top'
        ? `${personaDescription}\n${mergedAuthorNote}`.trim()
        : `${mergedAuthorNote}\n${personaDescription}`.trim();
  }
  if (mergedAuthorNote.length > 0) {
    addSystemBlock('authors-note', 'core.authors-note', mergedAuthorNote);
  }

  const preparedBlocks = configuredBlocks.map((block, configuredIndex) => {
    const hostMessages = isCorePromptBlockId(block.id) ? (buckets.get(block.id) ?? []) : [];
    const messages = preparePromptBlockMessages(block, hostMessages, macros);
    const triggerMatches =
      !block.triggers ||
      block.triggers.length === 0 ||
      block.triggers.includes(input.generationType ?? 'normal');
    const modelMatches = !block.model || block.model === input.model;
    return {
      block,
      configuredIndex,
      messages,
      active: block.enabled && triggerMatches && modelMatches,
      modelMatches,
      inChat: block.id !== 'chat-history' && block.injectionPosition === 'in-chat',
    };
  });

  const output: PromptMessage[] = [];
  const journal: PromptAuditJournalItem[] = [];
  for (const prepared of preparedBlocks) {
    const { block, messages, active } = prepared;
    if (messages.length === 0) {
      journal.push({
        blockId: block.id,
        message: {
          id: `block.${block.id}`,
          role: 'system',
          content: '',
          source: 'system',
        },
        exclusionReason: active ? 'empty' : exclusionReasonForBlock(prepared),
      });
      continue;
    }
    for (const message of messages) {
      journal.push({
        blockId: block.id,
        message,
        exclusionReason: active ? 'none' : exclusionReasonForBlock(prepared),
      });
    }
  }

  const inChatBlocks = preparedBlocks.filter((prepared) => prepared.active && prepared.inChat);
  for (const prepared of preparedBlocks) {
    if (prepared.block.id === 'chat-history') {
      const history = prepared.active ? prepared.messages : [];
      output.push(...mergeInChatPrompts(history, inChatBlocks));
    } else if (prepared.active && !prepared.inChat) {
      output.push(...prepared.messages);
    }
  }
  return { messages: output, journal };
}

/**
 * Audit label for an inactive block: a block bound to a model different from
 * the active one reports `model-mismatch` instead of the generic `disabled`.
 */
function exclusionReasonForBlock(prepared: {
  modelMatches: boolean;
}): 'disabled' | 'model-mismatch' {
  return prepared.modelMatches ? 'disabled' : 'model-mismatch';
}

function preparePromptBlockMessages(
  block: PromptBlockSettings,
  hostMessages: readonly PromptMessage[],
  macros: MacroContext,
): PromptMessage[] {
  if (block.id.startsWith('custom-')) {
    if (!block.content || block.content.trim().length === 0) return [];
    return [
      {
        id: `template.${block.id}`,
        name: block.name,
        role: block.role ?? 'system',
        content: replaceMacros(block.content, macros),
        pinned: false,
        source: 'template',
      },
    ];
  }

  if (block.id === 'chat-history' || block.id === 'dialogue-examples' || !block.role) {
    return [...hostMessages];
  }
  return hostMessages.map((message) => ({ ...message, role: block.role ?? message.role }));
}

function mergeInChatPrompts(
  history: readonly PromptMessage[],
  injections: ReadonlyArray<{
    block: PromptBlockSettings;
    configuredIndex: number;
    messages: PromptMessage[];
  }>,
): PromptMessage[] {
  const roleOrder: Record<GenerationMessage['role'], number> = {
    assistant: 0,
    user: 1,
    system: 2,
    tool: 3,
    plugin: 4,
  };
  const byBoundary = new Map<
    number,
    Array<{
      message: PromptMessage;
      injectionOrder: number;
      configuredIndex: number;
    }>
  >();

  for (const injection of injections) {
    const depth = injection.block.injectionDepth ?? 4;
    const boundary = Math.max(0, history.length - depth);
    const atBoundary = byBoundary.get(boundary) ?? [];
    for (const message of injection.messages) {
      atBoundary.push({
        message,
        injectionOrder: injection.block.injectionOrder ?? 100,
        configuredIndex: injection.configuredIndex,
      });
    }
    byBoundary.set(boundary, atBoundary);
  }

  const merged: PromptMessage[] = [];
  for (let boundary = 0; boundary <= history.length; boundary += 1) {
    const insertions = byBoundary.get(boundary) ?? [];
    insertions.sort(
      (left, right) =>
        left.injectionOrder - right.injectionOrder ||
        roleOrder[left.message.role] - roleOrder[right.message.role] ||
        left.configuredIndex - right.configuredIndex,
    );
    merged.push(...insertions.map((insertion) => insertion.message));
    const historyMessage = history[boundary];
    if (historyMessage) merged.push(historyMessage);
  }
  return merged;
}
