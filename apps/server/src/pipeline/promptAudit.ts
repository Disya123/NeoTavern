import type {
  PromptBlockId,
  PromptContextAuditEntry,
  PromptContextExclusionReason,
} from '@neotavern/contracts';
import type { ContextShiftResult, PromptMessage, TokenCounter } from './contextShift.js';

export interface PromptAuditJournalItem {
  blockId: PromptBlockId;
  message: PromptMessage;
  exclusionReason: PromptContextExclusionReason;
}

/** Classify assembled, excluded, plugin-modified, and final prompt entries. */
export async function buildPromptAuditEntries(
  journal: readonly PromptAuditJournalItem[],
  initiallyExcluded: readonly PromptMessage[],
  afterInterceptors: readonly PromptMessage[],
  finalShift: ContextShiftResult,
  manualExcludedIds: ReadonlySet<string>,
  countTokens: TokenCounter,
): Promise<PromptContextAuditEntry[]> {
  const initialExcludedIds = new Set(
    initiallyExcluded.map((message) => message.id).filter((id): id is string => id !== undefined),
  );
  const initialExcludedObjects = new Set(initiallyExcluded);
  const workingById = new Map(
    afterInterceptors
      .filter((message): message is PromptMessage & { id: string } => message.id !== undefined)
      .map((message) => [message.id, message]),
  );
  const workingObjects = new Set(afterInterceptors);
  const finalById = new Map(
    finalShift.kept
      .filter((message): message is PromptMessage & { id: string } => message.id !== undefined)
      .map((message) => [message.id, message]),
  );
  const finalObjects = new Set(finalShift.kept);
  const finalExcludedIds = new Set(
    finalShift.excluded.map((message) => message.id).filter((id): id is string => id !== undefined),
  );
  const finalExcludedObjects = new Set(finalShift.excluded);
  const assembledIds = new Set(
    journal
      .map((item) => item.message.id)
      .filter((id): id is string => id !== undefined && !id.startsWith('block.')),
  );
  const classified: Array<{
    message: PromptMessage;
    name?: string;
    included: boolean;
    exclusionReason: PromptContextExclusionReason;
  }> = [];

  for (const item of journal) {
    const id = item.message.id;
    const current = (id ? (finalById.get(id) ?? workingById.get(id)) : undefined) ?? item.message;
    let exclusionReason = item.exclusionReason;
    let included = false;
    if (exclusionReason === 'none') {
      if (
        (id !== undefined && initialExcludedIds.has(id)) ||
        initialExcludedObjects.has(item.message)
      ) {
        exclusionReason =
          id !== undefined && manualExcludedIds.has(id) ? 'manual' : 'context-shift';
      } else if (
        (id !== undefined && finalExcludedIds.has(id)) ||
        finalExcludedObjects.has(current)
      ) {
        exclusionReason = 'final-budget';
      } else if ((id !== undefined && finalById.has(id)) || finalObjects.has(current)) {
        included = true;
      } else if (
        (id !== undefined && !workingById.has(id)) ||
        (id === undefined && !workingObjects.has(item.message))
      ) {
        exclusionReason = 'interceptor';
      }
    }
    classified.push({
      message: current,
      name: current.name ?? item.blockId,
      included,
      exclusionReason,
    });
  }

  for (const message of afterInterceptors) {
    if (message.id && assembledIds.has(message.id)) continue;
    const included =
      (message.id !== undefined && finalById.has(message.id)) || finalObjects.has(message);
    const finalExcluded =
      (message.id !== undefined && finalExcludedIds.has(message.id)) ||
      finalExcludedObjects.has(message);
    classified.push({
      message,
      ...(message.name ? { name: message.name } : {}),
      included,
      exclusionReason: included ? 'none' : finalExcluded ? 'final-budget' : 'interceptor',
    });
  }

  const bounded = classified.slice(0, 500);
  const tokenCounts = await Promise.all(
    bounded.map(async (item) =>
      item.message.content.length === 0 ? 0 : (await countTokens(item.message.content)) + 4,
    ),
  );
  return bounded.map((item, order) => ({
    identifier: item.message.id ?? `pipeline.${order}`,
    ...(item.name ? { name: item.name } : {}),
    role: item.message.role,
    source: item.message.source ?? 'system',
    content: item.message.content,
    tokens: tokenCounts[order] ?? 0,
    included: item.included,
    exclusionReason: item.exclusionReason,
    order,
  }));
}
