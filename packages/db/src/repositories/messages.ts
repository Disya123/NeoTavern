/**
 * Message repository: append, cursor-paginated reads (old messages loaded in
 * batches), update and delete. Never loads an entire chat into memory.
 */
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type {
  CursorPage,
  MessageContentRevision,
  Message,
  MessageCreate,
  MessageUpdate,
  MessageVariant,
} from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { characters, messageContentRevisions, messages, messageVariants } from '../schema/index.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { parseJson, toJson } from '../json.js';

type MessageRow = typeof messages.$inferSelect;
type MessageVariantRow = typeof messageVariants.$inferSelect;
type MessageContentRevisionRow = typeof messageContentRevisions.$inferSelect;

function rowToVariant(row: MessageVariantRow): MessageVariant {
  return {
    id: row.id,
    messageId: row.messageId,
    position: row.position,
    content: row.content,
    createdAt: row.createdAt,
  };
}

function rowToContentRevision(row: MessageContentRevisionRow): MessageContentRevision {
  return {
    id: row.id,
    messageId: row.messageId,
    position: row.position,
    content: row.content,
    createdAt: row.createdAt,
  };
}

/** True when a better-sqlite3 error is a UNIQUE violation on our partial index. */
function isIdempotencyViolation(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const message = cause.message;
  return (
    typeof message === 'string' &&
    (message.includes('UNIQUE constraint failed') || message.includes('idx_messages_idempotency'))
  );
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chatId,
    branchId: row.branchId,
    parentId: row.parentId,
    role: row.role,
    content: row.content,
    name: row.name,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    createdAt: row.createdAt,
    revision: row.revision,
    updatedAt: row.updatedAt ?? null,
    variantCount: row.variantCount,
    activeVariantPosition: row.activeVariantPosition ?? null,
    checkpointChatId: row.checkpointChatId ?? null,
    contentRevisionCount: row.contentRevisionCount,
  };
}

/** Result of a CAS-guarded update (rev4 stage 3). */
export type MessageUpdateResult =
  | { status: 'updated'; message: Message }
  | { status: 'conflict'; currentRevision: number }
  | { status: 'missing' };

export type MessageRevisionRestoreResult = MessageUpdateResult | { status: 'revision-missing' };

export type MessageRevisionListOptions = { cursor?: string; limit?: number };
export interface MessageListOptions {
  cursor?: string;
  limit?: number;
  branchId?: string;
  order?: 'asc' | 'desc';
}

export class MessageRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  async create(chatId: string, branchId: string, input: MessageCreate): Promise<Message> {
    const now = this.clock();
    // The message insert and the character lastUsedAt touch are one unit
    // (OTHER-62): the usage index must not observe a message-less bump or
    // miss the bump for a committed message.
    const row = this.db.transaction((tx) => {
      let created: MessageRow | undefined;
      try {
        created = tx
          .insert(messages)
          .values({
            id: uuidv7(),
            chatId,
            branchId,
            parentId: input.parentId ?? null,
            role: input.role,
            content: input.content,
            name: input.name ?? null,
            meta: toJson(input.meta ?? {}),
            createdAt: now,
            revision: 1,
            idempotencyKey: input.idempotencyKey ?? null,
            // Fresh messages have exactly one variant: the active content.
            variantCount: 1,
            activeVariantPosition: 0,
          })
          .returning()
          .get();
      } catch (cause) {
        // Outbox dedupe (rev4 stage 3): a retried create with the same
        // (chatId, idempotencyKey) hits the unique index — return the
        // original message instead of duplicating it.
        if (input.idempotencyKey && isIdempotencyViolation(cause)) {
          created = tx
            .select()
            .from(messages)
            .where(
              and(eq(messages.chatId, chatId), eq(messages.idempotencyKey, input.idempotencyKey)),
            )
            .get() as MessageRow | undefined;
        } else {
          throw cause;
        }
      }
      if (!created) throw new Error('MESSAGE_IDEMPOTENCY_RACE');
      // The replayed create already bumped the character's lastUsedAt the
      // first time; the touch below is idempotent in effect.

      // A new message marks the chat's character as recently used (ТЗ §12).
      tx.update(characters)
        .set({ lastUsedAt: now })
        .where(eq(characters.id, sql`(SELECT character_id FROM chats WHERE id = ${chatId})`))
        .run();
      return created;
    });

    return rowToMessage(row);
  }

  async getById(id: string): Promise<Message | null> {
    const row = await this.db.select().from(messages).where(eq(messages.id, id)).get();
    return row ? rowToMessage(row) : null;
  }

  /** Message ids that exist inside one chat (batch ownership check). */
  async listIdsInChat(chatId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), inArray(messages.id, ids)))
      .all();
    return rows.map((row) => row.id);
  }

  async list(chatId: string, options: MessageListOptions = {}): Promise<CursorPage<Message>> {
    const limit = options.limit ?? 100;
    const order = options.order ?? 'desc';

    const conds = [];
    conds.push(eq(messages.chatId, chatId));
    if (options.branchId) conds.push(eq(messages.branchId, options.branchId));

    const decoded = decodeCursor(options.cursor);
    const cursorC = typeof decoded?.['c'] === 'number' ? (decoded['c'] as number) : null;
    const cursorI = typeof decoded?.['i'] === 'string' ? (decoded['i'] as string) : null;
    if (cursorC !== null && cursorI !== null) {
      if (order === 'asc') {
        conds.push(
          or(
            gt(messages.createdAt, cursorC),
            and(eq(messages.createdAt, cursorC), gt(messages.id, cursorI)),
          ),
        );
      } else {
        conds.push(
          or(
            lt(messages.createdAt, cursorC),
            and(eq(messages.createdAt, cursorC), lt(messages.id, cursorI)),
          ),
        );
      }
    }

    const orderBy =
      order === 'asc'
        ? [asc(messages.createdAt), asc(messages.id)]
        : [desc(messages.createdAt), desc(messages.id)];

    const rows = await this.db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(...orderBy)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = page[page.length - 1];
      if (last) nextCursor = encodeCursor({ c: last.createdAt, i: last.id });
    }
    return { items: page.map(rowToMessage), nextCursor, hasMore };
  }

  /**
   * Fetch the most recent `count` messages for a branch in ascending order —
   * used to build the generation prompt.
   */
  async recentAscending(chatId: string, branchId: string, count: number): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.branchId, branchId)))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(count);
    return rows.reverse().map(rowToMessage);
  }

  /**
   * Stream every message of a chat (all branches) in ascending order without
   * materializing the whole set at once — used by chat export.
   */
  async exportAll(chatId: string): Promise<Message[]> {
    const batchSize = 1000;
    const all: Message[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.list(chatId, {
        cursor,
        limit: batchSize,
        order: 'asc',
      });
      all.push(...page.items);
      if (!page.hasMore || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return all;
  }

  /** All swipe variants for a standalone chat export. */
  async exportVariants(chatId: string): Promise<MessageVariant[]> {
    const rows = await this.db
      .select({
        id: messageVariants.id,
        messageId: messageVariants.messageId,
        position: messageVariants.position,
        content: messageVariants.content,
        createdAt: messageVariants.createdAt,
      })
      .from(messageVariants)
      .innerJoin(messages, eq(messageVariants.messageId, messages.id))
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messageVariants.messageId), asc(messageVariants.position))
      .all();
    return rows.map(rowToVariant);
  }

  /** All manual content revisions for a standalone chat export. */
  async exportContentRevisions(chatId: string): Promise<MessageContentRevision[]> {
    const rows = await this.db
      .select({
        id: messageContentRevisions.id,
        messageId: messageContentRevisions.messageId,
        position: messageContentRevisions.position,
        content: messageContentRevisions.content,
        createdAt: messageContentRevisions.createdAt,
      })
      .from(messageContentRevisions)
      .innerJoin(messages, eq(messageContentRevisions.messageId, messages.id))
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messageContentRevisions.messageId), asc(messageContentRevisions.position))
      .all();
    return rows.map(rowToContentRevision);
  }

  /**
   * CAS-guarded update (rev4 stage 3). When `expectedRevision` is provided the
   * write only applies if the stored revision still matches — otherwise the
   * caller gets `currentRevision` to retry against. Unconditional updates
   * (no expectedRevision) always apply and still bump the revision.
   */
  async update(
    id: string,
    patch: MessageUpdate,
    expectedRevision?: number,
    options: { trackContentRevision?: boolean } = {},
  ): Promise<MessageUpdateResult> {
    const now = this.clock();
    return this.db.transaction((tx) => {
      const conditions = [eq(messages.id, id)];
      if (expectedRevision !== undefined) conditions.push(eq(messages.revision, expectedRevision));
      const current = tx
        .select()
        .from(messages)
        .where(and(...conditions))
        .get();
      if (!current) {
        const existing = tx
          .select({ revision: messages.revision })
          .from(messages)
          .where(eq(messages.id, id))
          .get();
        return existing && expectedRevision !== undefined
          ? { status: 'conflict' as const, currentRevision: existing.revision }
          : { status: 'missing' as const };
      }

      const values: Partial<MessageRow> = {};
      const contentChanged = patch.content !== undefined && patch.content !== current.content;
      if (patch.content !== undefined) values.content = patch.content;
      if (patch.role !== undefined) values.role = patch.role;
      if (patch.meta !== undefined) values.meta = toJson(patch.meta);
      if (patch.checkpointChatId !== undefined) values.checkpointChatId = patch.checkpointChatId;

      if (contentChanged && options.trackContentRevision !== false) {
        tx.insert(messageContentRevisions)
          .values({
            id: uuidv7(),
            messageId: id,
            position: current.contentRevisionCount,
            content: current.content,
            createdAt: current.updatedAt ?? current.createdAt,
          })
          .run();
        values.contentRevisionCount = current.contentRevisionCount + 1;
      }

      const row = tx
        .update(messages)
        .set({ ...values, revision: current.revision + 1, updatedAt: now })
        .where(and(eq(messages.id, id), eq(messages.revision, current.revision)))
        .returning()
        .get();
      return row
        ? { status: 'updated' as const, message: rowToMessage(row) }
        : { status: 'conflict' as const, currentRevision: current.revision };
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(messages).where(eq(messages.id, id)).run();
    return result.changes > 0;
  }

  async count(chatId: string, branchId: string): Promise<number> {
    // COUNT(*) — never materializes the row set (matches the "never loads an
    // entire chat" contract of this repository).
    const row = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.branchId, branchId)))
      .get();
    return row?.n ?? 0;
  }

  // --- variants (swipes, ST1) ---

  async listVariants(messageId: string): Promise<MessageVariant[]> {
    const rows = await this.db
      .select()
      .from(messageVariants)
      .where(eq(messageVariants.messageId, messageId))
      .orderBy(
        asc(messageVariants.position),
        asc(messageVariants.createdAt),
        asc(messageVariants.id),
      )
      .all();
    return rows.map(rowToVariant);
  }

  /** List immutable manual-edit history newest first without loading it eagerly. */
  async listContentRevisions(
    messageId: string,
    options: MessageRevisionListOptions = {},
  ): Promise<CursorPage<MessageContentRevision>> {
    const limit = options.limit ?? 50;
    const conditions = [eq(messageContentRevisions.messageId, messageId)];
    const decoded = decodeCursor(options.cursor);
    const cursorPosition = typeof decoded?.['p'] === 'number' ? decoded['p'] : null;
    if (cursorPosition !== null)
      conditions.push(lt(messageContentRevisions.position, cursorPosition));
    const rows = await this.db
      .select()
      .from(messageContentRevisions)
      .where(and(...conditions))
      .orderBy(desc(messageContentRevisions.position), desc(messageContentRevisions.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(rowToContentRevision),
      nextCursor: hasMore && last ? encodeCursor({ p: last.position }) : null,
      hasMore,
    };
  }

  /** Restore an archived text while first archiving the current active text. */
  async restoreContentRevision(
    messageId: string,
    revisionId: string,
    expectedRevision: number,
  ): Promise<MessageRevisionRestoreResult> {
    const now = this.clock();
    return this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.revision, expectedRevision)))
        .get();
      if (!current) {
        const existing = tx
          .select({ revision: messages.revision })
          .from(messages)
          .where(eq(messages.id, messageId))
          .get();
        return existing
          ? { status: 'conflict' as const, currentRevision: existing.revision }
          : { status: 'missing' as const };
      }
      const selected = tx
        .select()
        .from(messageContentRevisions)
        .where(
          and(
            eq(messageContentRevisions.id, revisionId),
            eq(messageContentRevisions.messageId, messageId),
          ),
        )
        .get();
      if (!selected) return { status: 'revision-missing' as const };
      if (selected.content === current.content) {
        return { status: 'updated' as const, message: rowToMessage(current) };
      }
      tx.insert(messageContentRevisions)
        .values({
          id: uuidv7(),
          messageId,
          position: current.contentRevisionCount,
          content: current.content,
          createdAt: current.updatedAt ?? current.createdAt,
        })
        .run();
      const updated = tx
        .update(messages)
        .set({
          content: selected.content,
          contentRevisionCount: current.contentRevisionCount + 1,
          revision: current.revision + 1,
          updatedAt: now,
        })
        .where(and(eq(messages.id, messageId), eq(messages.revision, current.revision)))
        .returning()
        .get();
      return updated
        ? { status: 'updated' as const, message: rowToMessage(updated) }
        : { status: 'conflict' as const, currentRevision: current.revision };
    });
  }

  /**
   * Non-destructive swipe: make the stored variant at `position` active.
   *
   * Positions form a permutation of `0..variant_count-1` with exactly one
   * hole — the active position (content lives in `messages.content`). The
   * swap inserts the current content as a variant at the old active position
   * and deletes the activated variant row, so both texts are preserved and
   * the variant count stays constant. Atomic: a failure leaves the message
   * untouched. Optional CAS via `expectedRevision` (MESSAGE_CONFLICT when the
   * stored revision moved on).
   */
  async setActiveVariant(
    messageId: string,
    position: number,
    expectedRevision?: number,
  ): Promise<MessageUpdateResult> {
    return this.db.transaction((tx) => {
      const now = this.clock();
      const conditions = [eq(messages.id, messageId)];
      if (expectedRevision !== undefined) conditions.push(eq(messages.revision, expectedRevision));
      const message = tx
        .select()
        .from(messages)
        .where(and(...conditions))
        .get();
      if (!message) {
        if (expectedRevision !== undefined) {
          const current = tx
            .select({ revision: messages.revision })
            .from(messages)
            .where(eq(messages.id, messageId))
            .get();
          return current
            ? { status: 'conflict', currentRevision: current.revision }
            : { status: 'missing' };
        }
        return { status: 'missing' };
      }
      const variant = tx
        .select()
        .from(messageVariants)
        .where(
          and(eq(messageVariants.messageId, messageId), eq(messageVariants.position, position)),
        )
        .get();
      if (!variant) return { status: 'missing' };
      const oldActive = message.activeVariantPosition ?? 0;
      tx.insert(messageVariants)
        .values({
          id: uuidv7(),
          messageId,
          position: oldActive,
          content: message.content,
          createdAt: now,
        })
        .run();
      const updated = tx
        .update(messages)
        .set({
          content: variant.content,
          activeVariantPosition: position,
          revision: message.revision + 1,
          updatedAt: now,
        })
        .where(eq(messages.id, messageId))
        .returning()
        .get();
      tx.delete(messageVariants).where(eq(messageVariants.id, variant.id)).run();
      return updated
        ? { status: 'updated', message: rowToMessage(updated) }
        : { status: 'missing' };
    });
  }

  /**
   * Legacy id-based activation kept for the old route (non-destructive).
   * Resolves the variant's position and delegates to {@link setActiveVariant}.
   */
  async activateVariant(
    messageId: string,
    variantId: string,
    expectedRevision?: number,
  ): Promise<MessageUpdateResult> {
    const variant = await this.db
      .select()
      .from(messageVariants)
      .where(and(eq(messageVariants.id, variantId), eq(messageVariants.messageId, messageId)))
      .get();
    if (!variant) return { status: 'missing' };
    return this.setActiveVariant(messageId, variant.position, expectedRevision);
  }

  /**
   * Atomic regenerate: archive the current content as a variant at the old
   * active position and write the replacement text + meta in one transaction.
   * On error nothing persists — the caller decides whether to retry.
   */
  async replaceContentAsVariant(
    messageId: string,
    input: { archiveContent: string; content: string; meta: Record<string, unknown> },
  ): Promise<MessageUpdateResult> {
    return this.db.transaction((tx) => {
      const now = this.clock();
      const message = tx.select().from(messages).where(eq(messages.id, messageId)).get();
      if (!message) return { status: 'missing' };
      const oldActive = message.activeVariantPosition ?? 0;
      tx.insert(messageVariants)
        .values({
          id: uuidv7(),
          messageId,
          position: oldActive,
          content: input.archiveContent,
          createdAt: now,
        })
        .run();
      const updated = tx
        .update(messages)
        .set({
          content: input.content,
          meta: toJson(input.meta),
          variantCount: message.variantCount + 1,
          activeVariantPosition: message.variantCount,
          revision: message.revision + 1,
          updatedAt: now,
        })
        .where(eq(messages.id, messageId))
        .returning()
        .get();
      return updated
        ? { status: 'updated', message: rowToMessage(updated) }
        : { status: 'missing' };
    });
  }

  /** Set/repoint the checkpoint flag linking a message to its child chat. */
  async linkCheckpoint(messageId: string, childChatId: string): Promise<boolean> {
    const result = await this.db
      .update(messages)
      .set({
        checkpointChatId: childChatId,
        revision: sql`${messages.revision} + 1`,
        updatedAt: this.clock(),
      })
      .where(eq(messages.id, messageId))
      .run();
    return result.changes > 0;
  }
}
