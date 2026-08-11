/**
 * Server-side message drafts (rev4 stage 3).
 *
 * Streaming writers stream into a draft row; only `commit` materializes a
 * real message atomically. The row survives the commit (with
 * `committedMessageId` set) so a commit retry is idempotent, and the sweep
 * removes stale or committed rows — a crashed writer never leaves a
 * half-written committed message.
 */
import { and, eq, lt, or, sql } from 'drizzle-orm';
import type {
  Message,
  MessageDraft,
  MessageDraftCommitResult,
  MessageDraftCreate,
  MessageDraftUpdate,
} from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { messageDrafts, messages } from '../schema/index.js';
import { parseJson, toJson } from '../json.js';

type DraftRow = typeof messageDrafts.$inferSelect;

function rowToDraft(row: DraftRow): MessageDraft {
  return {
    id: row.id,
    chatId: row.chatId,
    branchId: row.branchId,
    role: row.role,
    content: row.content,
    name: row.name,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    sequence: row.sequence,
    revision: row.revision,
    committedMessageId: row.committedMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface DraftCommitOutcome {
  status: 'ok';
  result: MessageDraftCommitResult;
  message?: Message;
}

export class MessageDraftRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  async create(chatId: string, branchId: string, input: MessageDraftCreate): Promise<MessageDraft> {
    const now = this.clock();
    const row = this.db
      .insert(messageDrafts)
      .values({
        id: uuidv7(),
        chatId,
        branchId,
        role: input.role ?? 'assistant',
        content: '',
        name: input.name ?? null,
        meta: toJson(input.meta ?? {}),
        sequence: 0,
        revision: 1,
        committedMessageId: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return rowToDraft(row);
  }

  async getById(id: string): Promise<MessageDraft | null> {
    const row = await this.db.select().from(messageDrafts).where(eq(messageDrafts.id, id)).get();
    return row ? rowToDraft(row) : null;
  }

  /**
   * Apply a streaming write. `sequence` makes replayed PATCHes idempotent:
   * a sequence ≤ the stored one is a no-op (still reports the draft), and
   * every applied write bumps the CAS revision.
   */
  async update(
    id: string,
    patch: MessageDraftUpdate,
  ): Promise<{ status: 'applied' | 'stale' | 'missing'; draft?: MessageDraft }> {
    const current = await this.db
      .select({ sequence: messageDrafts.sequence })
      .from(messageDrafts)
      .where(eq(messageDrafts.id, id))
      .get();
    if (!current) return { status: 'missing' };
    if (patch.sequence !== undefined && patch.sequence <= current.sequence) {
      const draft = await this.getById(id);
      return draft ? { status: 'stale', draft } : { status: 'missing' };
    }
    const values: Partial<DraftRow> = {};
    if (patch.content !== undefined) values.content = patch.content;
    if (patch.role !== undefined) values.role = patch.role;
    if (patch.sequence !== undefined) values.sequence = patch.sequence;
    const row = this.db
      .update(messageDrafts)
      .set({ ...values, revision: sql`${messageDrafts.revision} + 1`, updatedAt: this.clock() })
      .where(eq(messageDrafts.id, id))
      .returning()
      .get();
    return row ? { status: 'applied', draft: rowToDraft(row) } : { status: 'missing' };
  }

  /**
   * Commit the draft as a real message, atomically. Idempotent: a retry after
   * a successful commit returns the original messageId (the row is kept with
   * `committedMessageId` until the sweep removes it).
   */
  async commit(id: string): Promise<DraftCommitOutcome | { status: 'missing' }> {
    const now = this.clock();
    return this.db.transaction((tx) => {
      const draft = tx.select().from(messageDrafts).where(eq(messageDrafts.id, id)).get();
      if (!draft) return { status: 'missing' as const };
      if (draft.committedMessageId) {
        return {
          status: 'ok' as const,
          result: { messageId: draft.committedMessageId, alreadyCommitted: true },
        };
      }
      const messageId = uuidv7();
      const created = tx
        .insert(messages)
        .values({
          id: messageId,
          chatId: draft.chatId,
          branchId: draft.branchId,
          parentId: null,
          role: draft.role,
          content: draft.content,
          name: draft.name,
          meta: draft.meta,
          createdAt: now,
          revision: 1,
          // Fresh messages have exactly one variant: the active content.
          variantCount: 1,
          activeVariantPosition: 0,
        })
        .returning()
        .get();
      tx.update(messageDrafts)
        .set({ committedMessageId: messageId, updatedAt: now })
        .where(eq(messageDrafts.id, id))
        .run();
      return {
        status: 'ok' as const,
        result: { messageId, alreadyCommitted: false },
        message: {
          id: created.id,
          chatId: created.chatId,
          branchId: created.branchId,
          parentId: created.parentId,
          role: created.role,
          content: created.content,
          name: created.name,
          meta: parseJson<Record<string, unknown>>(created.meta, {}),
          createdAt: created.createdAt,
          revision: created.revision,
          updatedAt: created.updatedAt ?? null,
          variantCount: created.variantCount,
          activeVariantPosition: created.activeVariantPosition ?? null,
          contentRevisionCount: created.contentRevisionCount,
          checkpointChatId: created.checkpointChatId ?? null,
        },
      };
    });
  }

  /** Abandon the draft (writer abort or session teardown). */
  async abort(id: string): Promise<boolean> {
    const result = await this.db.delete(messageDrafts).where(eq(messageDrafts.id, id)).run();
    return result.changes > 0;
  }

  /**
   * Sweep stale drafts (rev4 stage 3 recovery): committed drafts older than
   * `committedTtlMs` and uncommitted drafts older than `uncommittedTtlMs`
   * (a crashed writer) are removed. Runs at server start and on an interval;
   * never touches committed messages.
   */
  async sweep(now: number, committedTtlMs: number, uncommittedTtlMs: number): Promise<number> {
    const committedCutoff = now - committedTtlMs;
    const uncommittedCutoff = now - uncommittedTtlMs;
    const result = await this.db
      .delete(messageDrafts)
      .where(
        // Committed long ago (retry-safe row outlived its purpose) or never
        // committed and stale (crashed writer).
        or(
          and(
            sql`${messageDrafts.committedMessageId} IS NOT NULL`,
            lt(messageDrafts.updatedAt, committedCutoff),
          ),
          and(
            sql`${messageDrafts.committedMessageId} IS NULL`,
            lt(messageDrafts.updatedAt, uncommittedCutoff),
          ),
        ),
      )
      .run();
    return result.changes;
  }
}
