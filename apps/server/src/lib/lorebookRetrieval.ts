/**
 * Lorebook retrieval for the pipeline's Lorebook stage (ТЗ §4.4). Pure and
 * testable: given the candidate entries (already scoped to the character and
 * global books) and the scan context text, returns the blocks to inject.
 *
 * Activation rules (SillyTavern world-info semantics):
 * - constant entries are always injected as required (pinned) blocks;
 * - an entry activates when any primary key appears in the context text
 *   (case-insensitive substring match);
 * - selective entries additionally need a secondary key match;
 * - relevance = matched primary keys / total primary keys (0..1).
 */
import type { RetrievalEntry } from '@neotavern/db';
import type { PipelineContextBlock } from '../pipeline/promptPipeline.js';

const MAX_INJECTED_BLOCKS = 100;

function normalize(text: string): string {
  return text.toLowerCase();
}

export function retrieveLoreBlocks(
  entries: readonly RetrievalEntry[],
  contextText: string,
): PipelineContextBlock[] {
  const haystack = normalize(contextText);
  const blocks: PipelineContextBlock[] = [];

  for (const entry of entries) {
    if (entry.constant) {
      blocks.push({
        id: `lore.${entry.id}`,
        source: 'lorebook',
        content: entry.content,
        required: true,
        relevance: 1,
      });
      continue;
    }
    if (entry.keys.length === 0) continue;
    const matchedKeys = entry.keys.filter(
      (key) => key.trim().length > 0 && haystack.includes(normalize(key)),
    );
    if (matchedKeys.length === 0) continue;
    if (entry.selective) {
      const secondaryMatched = entry.secondaryKeys.some(
        (key) => key.trim().length > 0 && haystack.includes(normalize(key)),
      );
      if (!secondaryMatched) continue;
    }
    blocks.push({
      id: `lore.${entry.id}`,
      source: 'lorebook',
      content: entry.content,
      relevance: Math.max(0, Math.min(1, matchedKeys.length / entry.keys.length)),
    });
  }

  // Required (constant) blocks first, then the most relevant. Position keeps
  // author ordering as the tie-break (repository already sorts by it).
  blocks.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return (b.relevance ?? 0) - (a.relevance ?? 0);
  });
  return blocks.slice(0, MAX_INJECTED_BLOCKS);
}
