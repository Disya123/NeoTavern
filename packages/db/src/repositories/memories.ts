/**
 * Memory repository (ТЗ §4.4 Memory/RAG stage): CRUD plus the retrieval
 * projection the prompt pipeline consumes.
 */
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Memory, MemoryCreate, MemoryUpdate } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { memories } from '../schema/index.js';
import { parseJson, toJson } from '../json.js';
import { buildFtsQuery } from './search.js';

type MemoryRow = typeof memories.$inferSelect;

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: row.scope === 'character' ? 'character' : 'global',
    characterId: row.characterId,
    keys: parseJson<string[]>(row.keysJson, []),
    content: row.content,
    enabled: row.enabled,
    position: row.position,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Keyword-retrieval projection consumed by the pipeline (no metadata noise). */
export interface MemoryRetrievalEntry {
  id: string;
  keys: string[];
  content: string;
  position: number;
}

export interface MemoryListFilter {
  scope?: 'global' | 'character';
  /** Explicit character scope; `null` selects global memories only. */
  characterId?: string | null;
  enabled?: boolean;
}

export class MemoryRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  async create(input: MemoryCreate): Promise<Memory> {
    const now = this.clock();
    const scope = input.scope ?? (input.characterId ? 'character' : 'global');
    const row = await this.db
      .insert(memories)
      .values({
        id: uuidv7(),
        scope,
        characterId: scope === 'character' ? (input.characterId ?? null) : null,
        keysJson: toJson(input.keys ?? []),
        content: input.content,
        enabled: input.enabled ?? true,
        position: input.position ?? 0,
        metadata: toJson(input.metadata ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return rowToMemory(row);
  }

  async getById(id: string): Promise<Memory | null> {
    const row = await this.db.select().from(memories).where(eq(memories.id, id)).get();
    return row ? rowToMemory(row) : null;
  }

  async list(filter: MemoryListFilter = {}): Promise<Memory[]> {
    const conds = [];
    if (filter.scope) conds.push(eq(memories.scope, filter.scope));
    if (filter.characterId !== undefined) {
      conds.push(
        filter.characterId === null
          ? isNull(memories.characterId)
          : eq(memories.characterId, filter.characterId),
      );
    }
    if (filter.enabled !== undefined) conds.push(eq(memories.enabled, filter.enabled));
    const rows = await this.db
      .select()
      .from(memories)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(memories.position), asc(memories.createdAt))
      .all();
    return rows.map(rowToMemory);
  }

  async update(id: string, patch: MemoryUpdate): Promise<Memory | null> {
    const existing = await this.db.select().from(memories).where(eq(memories.id, id)).get();
    if (!existing) return null;
    const values: Partial<MemoryRow> = { updatedAt: this.clock() };
    if (patch.content !== undefined) values.content = patch.content;
    if (patch.keys !== undefined) values.keysJson = toJson(patch.keys);
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    if (patch.position !== undefined) values.position = patch.position;
    if (patch.metadata !== undefined) {
      values.metadata = toJson({
        ...parseJson<Record<string, unknown>>(existing.metadata, {}),
        ...patch.metadata,
      });
    }
    if (patch.scope !== undefined || patch.characterId !== undefined) {
      const scope = patch.scope ?? existing.scope;
      values.scope = scope;
      values.characterId =
        scope === 'character'
          ? patch.characterId !== undefined
            ? patch.characterId
            : existing.characterId
          : null;
    }
    const row = await this.db
      .update(memories)
      .set(values)
      .where(eq(memories.id, id))
      .returning()
      .get();
    return rowToMemory(row);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(memories).where(eq(memories.id, id)).run();
    return result.changes > 0;
  }

  /**
   * Enabled retrieval candidates for a chat: all global memories plus the
   * character-scoped ones for the given character, in author order.
   */
  async retrievalEntries(characterId: string | null): Promise<MemoryRetrievalEntry[]> {
    const rows = await this.db
      .select({
        id: memories.id,
        keysJson: memories.keysJson,
        content: memories.content,
        position: memories.position,
      })
      .from(memories)
      .where(
        and(
          eq(memories.enabled, true),
          characterId
            ? or(isNull(memories.characterId), eq(memories.characterId, characterId))
            : isNull(memories.characterId),
        ),
      )
      .orderBy(asc(memories.position), asc(memories.createdAt))
      .all();
    return rows.map((row) => ({
      id: row.id,
      keys: parseJson<string[]>(row.keysJson, []),
      content: row.content,
      position: row.position,
    }));
  }

  /**
   * FTS5 content-match ranks (bm25; lower is better) for a free-text query
   * (ТЗ §4.4 Memory/RAG stage — the `memories_fts` index exists for broader
   * matching than exact key hits). Returns memory id → rank; an empty map for
   * blank/unusable queries.
   */
  async ftsMatchRanks(query: string, limit = 100): Promise<Map<string, number>> {
    const expression = buildFtsQuery(query);
    if (expression.length === 0) return new Map();
    const rows = await this.db.all<{ id: string; rank: number }>(
      sql`SELECT memory_id AS id, rank AS rank
          FROM memories_fts
          WHERE memories_fts MATCH ${expression}
          ORDER BY rank
          LIMIT ${limit}`,
    );
    return new Map(rows.map((row) => [row.id, row.rank]));
  }
}
