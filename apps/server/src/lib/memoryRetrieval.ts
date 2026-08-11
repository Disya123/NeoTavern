/**
 * Memory/RAG retrieval for the pipeline's Memory stage (ТЗ §4.4). Pure and
 * testable, mirrors the lorebook rules: a memory activates when any of its
 * keys appears in the context text (case-insensitive substring match);
 * relevance = matched keys / total keys. Keyless memories are always active
 * (persona/world facts the author wants injected unconditionally).
 *
 * When FTS ranks are supplied (from the `memories_fts` index), memories whose
 * *content* matches the context are also activated at a fixed lower relevance
 * — this is the "broader matching" the FTS index exists for.
 */
import type { MemoryRetrievalEntry } from '@neotavern/db';
import type { PipelineContextBlock } from '../pipeline/promptPipeline.js';

const MAX_INJECTED_BLOCKS = 50;
/** Relevance for content-only matches found through FTS (below key hits). */
const FTS_CONTENT_RELEVANCE = 0.3;

function normalize(text: string): string {
  return text.toLowerCase();
}

export function retrieveMemoryBlocks(
  entries: readonly MemoryRetrievalEntry[],
  contextText: string,
  ftsRanks?: ReadonlyMap<string, number>,
): PipelineContextBlock[] {
  const haystack = normalize(contextText);
  const blocks: PipelineContextBlock[] = [];

  for (const entry of entries) {
    if (entry.content.trim().length === 0) continue;
    if (entry.keys.length === 0) {
      blocks.push({
        id: `memory.${entry.id}`,
        source: 'memory',
        content: entry.content,
        relevance: 0.5,
      });
      continue;
    }
    const matchedKeys = entry.keys.filter(
      (key) => key.trim().length > 0 && haystack.includes(normalize(key)),
    );
    const keyRelevance = matchedKeys.length / entry.keys.length;
    const contentMatched = ftsRanks?.has(entry.id) ?? false;
    if (matchedKeys.length === 0 && !contentMatched) continue;
    blocks.push({
      id: `memory.${entry.id}`,
      source: 'memory',
      content: entry.content,
      relevance: Math.max(
        contentMatched ? FTS_CONTENT_RELEVANCE : 0,
        Math.max(0, Math.min(1, keyRelevance)),
      ),
    });
  }

  // Most relevant first; repository pre-sort by position is the tie-break.
  blocks.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  return blocks.slice(0, MAX_INJECTED_BLOCKS);
}
