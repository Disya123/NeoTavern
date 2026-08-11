/**
 * Lorebook repository (ТЗ §4.1, §12). Books are standalone or linked to a
 * character through `metadata.characterId`; generation retrieval considers a
 * character's books plus all global (unlinked) books.
 */
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type {
  CursorPage,
  Lorebook,
  LorebookCreate,
  LorebookEntry,
  LorebookEntryCreate,
  LorebookEntryUpdate,
  LorebookUpdate,
} from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { Clock, DrizzleDb } from '../db.js';
import { lorebooks, loreEntries } from '../schema/index.js';
import { parseJson, toJson } from '../json.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

type LorebookRow = typeof lorebooks.$inferSelect;
type LoreEntryRow = typeof loreEntries.$inferSelect;

/** characterId is carried in the metadata JSON (no dedicated column). */
function readCharacterId(metadata: Record<string, unknown>): string | null {
  const value = metadata['characterId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function rowToLorebook(row: LorebookRow): Lorebook {
  const metadata = parseJson<Record<string, unknown>>(row.metadata, {});
  const characterId = readCharacterId(metadata);
  const publicMetadata = { ...metadata };
  delete publicMetadata['characterId'];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    characterId,
    metadata: publicMetadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToEntry(row: LoreEntryRow): LorebookEntry {
  return {
    id: row.id,
    lorebookId: row.lorebookId,
    keys: parseJson<string[]>(row.keysJson, []),
    secondaryKeys: parseJson<string[]>(row.secondaryKeys, []),
    content: row.content,
    enabled: row.enabled,
    position: row.position,
    constant: row.constant,
    selective: row.selective,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface LorebookListOptions {
  /** Limit to a character's books plus global books. Omit for all. */
  characterId?: string;
  cursor?: string;
  limit?: number;
  includeDeleted?: boolean;
}

/** Entry projection used by generation retrieval. */
export interface RetrievalEntry {
  id: string;
  lorebookId: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  position: number;
  constant: boolean;
  selective: boolean;
}

export class LorebookRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  async create(
    input: LorebookCreate,
    internalMetadata: Record<string, unknown> = {},
  ): Promise<Lorebook> {
    const now = this.clock();
    const id = uuidv7();
    const metadata: Record<string, unknown> = { ...internalMetadata };
    if (input.characterId) metadata['characterId'] = input.characterId;
    const row = await this.db
      .insert(lorebooks)
      .values({
        id,
        name: input.name,
        description: input.description ?? '',
        metadata: toJson(metadata),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    for (const entry of input.entries ?? []) {
      await this.createEntry(id, entry);
    }
    return rowToLorebook(row);
  }

  async getById(id: string): Promise<Lorebook | null> {
    const row = await this.db
      .select()
      .from(lorebooks)
      .where(and(eq(lorebooks.id, id), isNull(lorebooks.deletedAt)))
      .get();
    return row ? rowToLorebook(row) : null;
  }

  async list(options: LorebookListOptions = {}): Promise<CursorPage<Lorebook>> {
    const limit = options.limit ?? 50;
    const conds = [];
    if (!options.includeDeleted) conds.push(isNull(lorebooks.deletedAt));
    if (options.characterId) {
      // The character's own books plus every global (unlinked) book.
      conds.push(
        or(
          sql`json_extract(${lorebooks.metadata}, '$.characterId') = ${options.characterId}`,
          sql`json_extract(${lorebooks.metadata}, '$.characterId') IS NULL`,
        ),
      );
    }
    const decoded = decodeCursor(options.cursor);
    const cursorC = typeof decoded?.['c'] === 'number' ? (decoded['c'] as number) : null;
    const cursorI = typeof decoded?.['i'] === 'string' ? (decoded['i'] as string) : null;
    if (cursorC !== null && cursorI !== null) {
      conds.push(
        or(
          gt(lorebooks.createdAt, cursorC),
          and(eq(lorebooks.createdAt, cursorC), gt(lorebooks.id, cursorI)),
        ),
      );
    }

    const rows = await this.db
      .select()
      .from(lorebooks)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(lorebooks.createdAt), asc(lorebooks.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToLorebook);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ c: last.createdAt, i: last.id }) : null,
      hasMore,
    };
  }

  async update(id: string, patch: LorebookUpdate): Promise<Lorebook | null> {
    const values: Partial<LorebookRow> = { updatedAt: this.clock() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.characterId !== undefined) {
      const existing = await this.db.select().from(lorebooks).where(eq(lorebooks.id, id)).get();
      if (!existing || existing.deletedAt !== null) return null;
      const metadata = parseJson<Record<string, unknown>>(existing.metadata, {});
      if (patch.characterId === null) delete metadata['characterId'];
      else metadata['characterId'] = patch.characterId;
      values.metadata = toJson(metadata);
    }
    const row = await this.db
      .update(lorebooks)
      .set(values)
      .where(and(eq(lorebooks.id, id), isNull(lorebooks.deletedAt)))
      .returning()
      .get();
    return row ? rowToLorebook(row) : null;
  }

  /** Soft delete (trash semantics, consistent with characters/chats). */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.db
      .update(lorebooks)
      .set({ deletedAt: this.clock(), updatedAt: this.clock() })
      .where(and(eq(lorebooks.id, id), isNull(lorebooks.deletedAt)))
      .run();
    return result.changes > 0;
  }

  async restore(id: string): Promise<Lorebook | null> {
    const row = await this.db
      .update(lorebooks)
      .set({ deletedAt: null, updatedAt: this.clock() })
      .where(eq(lorebooks.id, id))
      .returning()
      .get();
    return row ? rowToLorebook(row) : null;
  }

  // --- entries ---

  async listEntries(lorebookId: string): Promise<LorebookEntry[]> {
    const rows = await this.db
      .select()
      .from(loreEntries)
      .where(eq(loreEntries.lorebookId, lorebookId))
      .orderBy(asc(loreEntries.position), asc(loreEntries.createdAt))
      .all();
    return rows.map(rowToEntry);
  }

  async getEntry(lorebookId: string, entryId: string): Promise<LorebookEntry | null> {
    const row = await this.db
      .select()
      .from(loreEntries)
      .where(and(eq(loreEntries.id, entryId), eq(loreEntries.lorebookId, lorebookId)))
      .get();
    return row ? rowToEntry(row) : null;
  }

  async createEntry(lorebookId: string, input: LorebookEntryCreate): Promise<LorebookEntry> {
    const now = this.clock();
    const row = await this.db
      .insert(loreEntries)
      .values({
        id: uuidv7(),
        lorebookId,
        keysJson: toJson(input.keys),
        secondaryKeys: toJson(input.secondaryKeys ?? []),
        content: input.content,
        enabled: input.enabled ?? true,
        position: input.position ?? 0,
        constant: input.constant ?? false,
        selective: input.selective ?? false,
        metadata: toJson(input.metadata ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    await this.touchBook(lorebookId);
    return rowToEntry(row);
  }

  async updateEntry(
    lorebookId: string,
    entryId: string,
    patch: LorebookEntryUpdate,
  ): Promise<LorebookEntry | null> {
    const values: Partial<LoreEntryRow> = { updatedAt: this.clock() };
    if (patch.keys !== undefined) values.keysJson = toJson(patch.keys);
    if (patch.secondaryKeys !== undefined) values.secondaryKeys = toJson(patch.secondaryKeys);
    if (patch.content !== undefined) values.content = patch.content;
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    if (patch.position !== undefined) values.position = patch.position;
    if (patch.constant !== undefined) values.constant = patch.constant;
    if (patch.selective !== undefined) values.selective = patch.selective;
    if (patch.metadata !== undefined) values.metadata = toJson(patch.metadata);
    const row = await this.db
      .update(loreEntries)
      .set(values)
      .where(and(eq(loreEntries.id, entryId), eq(loreEntries.lorebookId, lorebookId)))
      .returning()
      .get();
    if (!row) return null;
    await this.touchBook(lorebookId);
    return rowToEntry(row);
  }

  async deleteEntry(lorebookId: string, entryId: string): Promise<boolean> {
    const result = await this.db
      .delete(loreEntries)
      .where(and(eq(loreEntries.id, entryId), eq(loreEntries.lorebookId, lorebookId)))
      .run();
    if (result.changes > 0) await this.touchBook(lorebookId);
    return result.changes > 0;
  }

  /**
   * Enabled entries of all live books relevant to a generation context:
   * the character's books plus every global book (ТЗ §4.4 Lorebook stage).
   * Pass `null` for chats without a character (global books only).
   */
  async retrievalEntries(characterId: string | null): Promise<RetrievalEntry[]> {
    const characterScope =
      characterId === null
        ? sql`json_extract(${lorebooks.metadata}, '$.characterId') IS NULL`
        : or(
            sql`json_extract(${lorebooks.metadata}, '$.characterId') = ${characterId}`,
            sql`json_extract(${lorebooks.metadata}, '$.characterId') IS NULL`,
          );
    const rows = await this.db
      .select({
        id: loreEntries.id,
        lorebookId: loreEntries.lorebookId,
        keysJson: loreEntries.keysJson,
        secondaryKeys: loreEntries.secondaryKeys,
        content: loreEntries.content,
        position: loreEntries.position,
        constant: loreEntries.constant,
        selective: loreEntries.selective,
      })
      .from(loreEntries)
      .innerJoin(lorebooks, eq(loreEntries.lorebookId, lorebooks.id))
      .where(and(isNull(lorebooks.deletedAt), eq(loreEntries.enabled, true), characterScope))
      .orderBy(asc(loreEntries.position), asc(loreEntries.createdAt))
      .all();
    return rows.map((row) => ({
      id: row.id,
      lorebookId: row.lorebookId,
      keys: parseJson<string[]>(row.keysJson, []),
      secondaryKeys: parseJson<string[]>(row.secondaryKeys, []),
      content: row.content,
      position: row.position,
      constant: row.constant,
      selective: row.selective,
    }));
  }

  private async touchBook(lorebookId: string): Promise<void> {
    await this.db
      .update(lorebooks)
      .set({ updatedAt: this.clock() })
      .where(eq(lorebooks.id, lorebookId))
      .run();
  }
}
