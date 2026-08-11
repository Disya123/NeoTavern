/**
 * Chat repository: CRUD, branch management and cursor pagination.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Chat, ChatCreate, ChatUpdate, CursorPage } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { characters, chats, chatBranches, messages as messageRows } from '../schema/index.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { buildFtsQuery } from './search.js';

type ChatRow = typeof chats.$inferSelect;

/** Map a chats row to the API Chat shape (shared with snapshots repo). */
export function rowToChat(row: ChatRow): Chat {
  return {
    id: row.id,
    characterId: row.characterId,
    personaId: row.personaId,
    title: row.title,
    activeBranchId: row.activeBranchId,
    backgroundId: row.backgroundId,
    summary: row.summary,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    parentChatId: row.parentChatId ?? null,
    origin: row.origin ?? null,
    sourceMessageId: row.sourceMessageId ?? null,
  };
}

export interface ChatListOptions {
  cursor?: string;
  limit?: number;
  characterId?: string;
  q?: string;
  includeDeleted?: boolean;
  sort?: 'manual' | 'recent';
}

/** REST-facing chat catalog row enriched without changing the stored chat. */
export interface ChatListRecord extends Chat {
  characterName: string | null;
  characterAvatar: string | null;
}

export class ChatRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  /**
   * Create the chat, main branch, optional authored greeting, and character
   * usage update in one transaction.
   */
  async create(
    input: ChatCreate,
    initialAssistant?:
      | string
      | {
          content: string;
          meta?: Record<string, unknown>;
        },
  ): Promise<Chat> {
    const now = this.clock();
    const id = uuidv7();
    const branchId = uuidv7();
    const greetingContent =
      typeof initialAssistant === 'string'
        ? initialAssistant.trim().length > 0
          ? initialAssistant
          : null
        : initialAssistant !== undefined && initialAssistant.content.trim().length > 0
          ? initialAssistant.content
          : null;
    const greetingMeta =
      typeof initialAssistant === 'object' && initialAssistant !== null
        ? (initialAssistant.meta ?? {})
        : {};

    const row = this.db.transaction((tx) => {
      // Snapshot provenance validation (ST1): origin must be one of the known
      // kinds, and an origin requires both the parent chat and source message.
      const origin = input.origin ?? null;
      if (origin !== null && origin !== 'checkpoint' && origin !== 'branch') {
        throw new Error('SNAPSHOT_ORIGIN_INVALID');
      }
      if (origin !== null && (!input.parentChatId || !input.sourceMessageId)) {
        throw new Error('SNAPSHOT_INCOMPLETE');
      }
      const created = tx
        .insert(chats)
        .values({
          id,
          characterId: input.characterId ?? null,
          personaId: input.personaId ?? null,
          title: input.title ?? 'New chat',
          activeBranchId: branchId,
          summary: '',
          messageCount: greetingContent === null ? 0 : 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          parentChatId: input.parentChatId ?? null,
          origin,
          sourceMessageId: input.sourceMessageId ?? null,
        })
        .returning()
        .get();

      tx.insert(chatBranches)
        .values({ id: branchId, chatId: id, name: 'main', createdAt: now })
        .run();

      if (greetingContent !== null) {
        tx.insert(messageRows)
          .values({
            id: uuidv7(),
            chatId: id,
            branchId,
            parentId: null,
            role: 'assistant',
            content: greetingContent,
            name: null,
            meta: JSON.stringify(greetingMeta),
            createdAt: now,
          })
          .run();
      }

      // Starting a chat counts as usage for catalog ordering (ТЗ §12).
      if (input.characterId) {
        tx.update(characters)
          .set({ lastUsedAt: now })
          .where(eq(characters.id, input.characterId))
          .run();
      }

      return created;
    });

    return rowToChat(row);
  }

  async getById(id: string): Promise<Chat | null> {
    const row = await this.db.select().from(chats).where(eq(chats.id, id)).get();
    return row ? rowToChat(row) : null;
  }

  /** Return the newest live chat for a character that has never received user input. */
  async findUnstarted(characterId: string | null, personaId: string | null): Promise<Chat | null> {
    const row = await this.db
      .select()
      .from(chats)
      .where(
        and(
          isNull(chats.deletedAt),
          characterId === null ? isNull(chats.characterId) : eq(chats.characterId, characterId),
          personaId === null ? isNull(chats.personaId) : eq(chats.personaId, personaId),
          sql`NOT EXISTS (
            SELECT 1
            FROM ${messageRows}
            WHERE ${messageRows.chatId} = ${chats.id}
              AND ${messageRows.role} = 'user'
          )`,
        ),
      )
      .orderBy(desc(chats.updatedAt), desc(chats.id))
      .get();

    return row ? rowToChat(row) : null;
  }

  async list(options: ChatListOptions = {}): Promise<CursorPage<ChatListRecord>> {
    const limit = options.limit ?? 50;
    const sort = options.sort ?? 'manual';
    const conds = [];
    if (!options.includeDeleted) conds.push(isNull(chats.deletedAt));
    if (options.characterId) conds.push(eq(chats.characterId, options.characterId));
    if (options.q && options.q.trim().length > 0) {
      // Title/summary filtering goes through the trigger-synced chats_fts
      // index (prefix search, ТЗ §12) instead of an unindexable LIKE '%…%'
      // scan. Content search additionally unions hits from messages_fts so a
      // query finds chats by what was said in them, not just by title.
      const ftsQuery = buildFtsQuery(options.q.trim());
      const hits: string[] = [];
      if (ftsQuery.length > 0) {
        const titleHits = await this.db.all<{ id: string }>(
          sql`SELECT chat_id AS id
              FROM chats_fts
              WHERE chats_fts MATCH ${ftsQuery}
              LIMIT 1000`,
        );
        const contentHits = await this.db.all<{ id: string }>(
          sql`SELECT chat_id AS id
              FROM messages_fts
              WHERE messages_fts MATCH ${ftsQuery}
              GROUP BY chat_id
              LIMIT 1000`,
        );
        hits.push(...titleHits.map((h) => h.id), ...contentHits.map((h) => h.id));
      }
      const unique = [...new Set(hits)];
      conds.push(unique.length > 0 ? inArray(chats.id, unique) : sql`1 = 0`);
    }

    // Keyset cursor over the effective order (sort_order ASC, updated_at DESC,
    // id DESC). Chats not yet manually ordered share sort_order 0 and fall
    // back to updated_at DESC, so new chats surface on top (ТЗ §10.5).
    const decoded = decodeCursor(options.cursor);
    const cursorO = typeof decoded?.['o'] === 'number' ? (decoded['o'] as number) : null;
    const cursorC = typeof decoded?.['c'] === 'number' ? (decoded['c'] as number) : null;
    const cursorI = typeof decoded?.['i'] === 'string' ? (decoded['i'] as string) : null;
    const cursorSort = typeof decoded?.['s'] === 'string' ? decoded['s'] : null;

    if (sort === 'recent' && cursorSort === 'recent' && cursorC !== null && cursorI !== null) {
      conds.push(
        or(lt(chats.updatedAt, cursorC), and(eq(chats.updatedAt, cursorC), lt(chats.id, cursorI))),
      );
    } else if (sort === 'manual' && cursorO !== null && cursorC !== null && cursorI !== null) {
      conds.push(
        or(
          gt(chats.sortOrder, cursorO),
          and(
            eq(chats.sortOrder, cursorO),
            or(
              lt(chats.updatedAt, cursorC),
              and(eq(chats.updatedAt, cursorC), lt(chats.id, cursorI)),
            ),
          ),
        ),
      );
    }

    const rows = await this.db
      .select({
        chat: chats,
        characterName: characters.name,
        characterAvatar: characters.avatar,
      })
      .from(chats)
      .leftJoin(characters, eq(chats.characterId, characters.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(
        ...(sort === 'recent'
          ? [desc(chats.updatedAt), desc(chats.id)]
          : [asc(chats.sortOrder), desc(chats.updatedAt), desc(chats.id)]),
      )
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = page[page.length - 1];
      if (last) {
        nextCursor =
          sort === 'recent'
            ? encodeCursor({ s: 'recent', c: last.chat.updatedAt, i: last.chat.id })
            : encodeCursor({
                o: last.chat.sortOrder,
                c: last.chat.updatedAt,
                i: last.chat.id,
              });
      }
    }
    return {
      items: page.map((row) => ({
        ...rowToChat(row.chat),
        characterName: row.characterName,
        characterAvatar: row.characterAvatar,
      })),
      nextCursor,
      hasMore,
    };
  }

  async update(id: string, patch: ChatUpdate): Promise<Chat | null> {
    const values: Partial<ChatRow> = { updatedAt: this.clock() };
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.personaId !== undefined) values.personaId = patch.personaId;
    if (patch.activeBranchId !== undefined) values.activeBranchId = patch.activeBranchId;
    if (patch.backgroundId !== undefined) values.backgroundId = patch.backgroundId;
    if (patch.summary !== undefined) values.summary = patch.summary;

    const row = await this.db.update(chats).set(values).where(eq(chats.id, id)).returning().get();
    return row ? rowToChat(row) : null;
  }

  /** Bump updatedAt (e.g. after a new message) without changing fields. */
  async touch(id: string): Promise<void> {
    await this.db.update(chats).set({ updatedAt: this.clock() }).where(eq(chats.id, id)).run();
  }

  /** Detach a wallpaper from every chat (used when the file is deleted). */
  async clearBackgroundReference(backgroundId: string): Promise<void> {
    await this.db
      .update(chats)
      .set({ backgroundId: null })
      .where(eq(chats.backgroundId, backgroundId))
      .run();
  }

  /**
   * Persist a manual ordering for a character's chats (drag & drop, ТЗ §10.5).
   *
   * The provided list is treated as the desired leading order; it may be a
   * partial list when the caller only loaded one page. Chats that belong to the
   * character but are not present in the list keep their relative position
   * after the listed ones, so a reorder of a large, paged library never hides
   * or scrambles the remainder. Chats of other characters or soft-deleted
   * chats are rejected.
   *
   * Returns the number of chats renumbered and the ids that were invalid.
   */
  async reorder(
    characterId: string,
    orderedIds: string[],
  ): Promise<{ reordered: number; invalidIds: string[] }> {
    const unique = [...new Set(orderedIds)];
    if (unique.length !== orderedIds.length) {
      throw new Error('CHAT_REORDER_DUPLICATE_IDS');
    }

    // All live chats of the character, in their current effective order. Chats
    // missing from the request keep their existing relative order below the
    // reordered block.
    const rows = await this.db
      .select({
        id: chats.id,
        sortOrder: chats.sortOrder,
        updatedAt: chats.updatedAt,
      })
      .from(chats)
      .where(and(eq(chats.characterId, characterId), isNull(chats.deletedAt)))
      .orderBy(asc(chats.sortOrder), desc(chats.updatedAt), desc(chats.id))
      .all();

    const owned = new Set(rows.map((row) => row.id));
    const invalidIds = unique.filter((id) => !owned.has(id));
    const reordered = unique.filter((id) => owned.has(id));
    const pending = new Set(reordered);
    const rest = rows.filter((row) => !pending.has(row.id));
    const ordered = [...reordered, ...rest.map((row) => row.id)];

    if (ordered.length === 0) return { reordered: 0, invalidIds };

    await this.db.transaction((tx) => {
      ordered.forEach((id, index) => {
        tx.update(chats)
          .set({ sortOrder: index + 1 })
          .where(eq(chats.id, id))
          .run();
      });
    });
    return { reordered: reordered.length, invalidIds };
  }

  async setMessageCount(id: string, count: number): Promise<void> {
    await this.db
      .update(chats)
      .set({ messageCount: count, updatedAt: this.clock() })
      .where(eq(chats.id, id))
      .run();
  }

  async softDelete(id: string): Promise<boolean> {
    const result = await this.db
      .update(chats)
      .set({ deletedAt: this.clock(), updatedAt: this.clock() })
      .where(eq(chats.id, id))
      .run();
    return result.changes > 0;
  }

  /** Restore from trash (ТЗ §10.2: soft delete with a recoverable bin). */
  async restore(id: string): Promise<boolean> {
    const result = await this.db
      .update(chats)
      .set({ deletedAt: null, updatedAt: this.clock() })
      .where(eq(chats.id, id))
      .run();
    return result.changes > 0;
  }

  /** Hard delete (permanent; empties the trash entry and its messages). */
  async hardDelete(id: string): Promise<boolean> {
    const result = await this.db.delete(chats).where(eq(chats.id, id)).run();
    return result.changes > 0;
  }

  async createBranch(chatId: string, name: string): Promise<string> {
    const id = uuidv7();
    await this.db.insert(chatBranches).values({ id, chatId, name, createdAt: this.clock() }).run();
    return id;
  }

  async listBranches(chatId: string): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.db
      .select({ id: chatBranches.id, name: chatBranches.name })
      .from(chatBranches)
      .where(eq(chatBranches.chatId, chatId));
    return rows;
  }
}
