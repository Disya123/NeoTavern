/**
 * Snapshot repository (ST1): checkpoint / branch child chats.
 *
 * A snapshot copies the ACTIVE-branch prefix of a chat up to and including a
 * chosen message into a fresh child chat. The copy is batched (keyset cursor
 * over (created_at, id), 500 messages per batch) with an in-memory old→new id
 * map — the whole conversation is never loaded at once. `meta` is copied as
 * RAW TEXT so unknown fields survive verbatim; variants and persistent plugin
 * block attachments ride along with their message.
 */
import { and, asc, eq, gt, inArray, or, type SQL } from 'drizzle-orm';
import type { Chat } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import {
  chatBranches,
  chats,
  messageBlockAttachments,
  messageContentRevisions,
  messages,
  messageVariants,
} from '../schema/index.js';
import { rowToChat } from './chats.js';

export interface SnapshotInput {
  parentChatId: string;
  sourceMessageId: string;
  kind: 'checkpoint' | 'branch';
  title?: string;
}

export interface SnapshotResult {
  chat: Chat;
  copiedMessages: number;
}

/** Messages copied per batch (never the whole chat at once). */
const SNAPSHOT_BATCH_SIZE = 500;

export class SnapshotRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  /** null when the parent chat or source message is missing/unreachable. */
  async createSnapshot(input: SnapshotInput): Promise<SnapshotResult | null> {
    return this.db.transaction((tx) => {
      const parent = tx.select().from(chats).where(eq(chats.id, input.parentChatId)).get();
      if (!parent) return null;
      const message = tx
        .select()
        .from(messages)
        .where(eq(messages.id, input.sourceMessageId))
        .get();
      if (!message) return null;
      // The source must live in the parent's ACTIVE branch (the route also
      // validates; the repo re-checks so a stale caller cannot snapshot a
      // message the client cannot see).
      const activeBranchId = parent.activeBranchId;
      if (message.chatId !== parent.id) return null;
      if (activeBranchId === null || message.branchId !== activeBranchId) return null;

      const now = this.clock();
      const childChatId = uuidv7();
      const branchId = uuidv7();

      // Child chat inherits character/persona/background/summary; the title
      // defaults to "<parent title> — <kind>" unless provided.
      tx.insert(chats)
        .values({
          id: childChatId,
          characterId: parent.characterId,
          personaId: parent.personaId,
          title: input.title ?? `${parent.title} — ${input.kind}`,
          activeBranchId: branchId,
          backgroundId: parent.backgroundId,
          summary: parent.summary,
          messageCount: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          parentChatId: parent.id,
          origin: input.kind,
          sourceMessageId: input.sourceMessageId,
        })
        .run();
      tx.insert(chatBranches)
        .values({ id: branchId, chatId: childChatId, name: 'main', createdAt: now })
        .run();

      // Batched keyset copy of the active-branch prefix up to and including
      // the source message. Ids are remapped through an in-memory map so the
      // parentId chain stays intact inside the copied prefix.
      const idMap = new Map<string, string>();
      let copied = 0;
      let reached = false;
      let cursorC: number | null = null;
      let cursorI: string | null = null;
      while (!reached) {
        const conds: Array<SQL | undefined> = [
          eq(messages.chatId, parent.id),
          eq(messages.branchId, activeBranchId),
        ];
        if (cursorC !== null && cursorI !== null) {
          conds.push(
            or(
              gt(messages.createdAt, cursorC),
              and(eq(messages.createdAt, cursorC), gt(messages.id, cursorI)),
            ),
          );
        }
        const batch = tx
          .select()
          .from(messages)
          .where(and(...conds))
          .orderBy(asc(messages.createdAt), asc(messages.id))
          .limit(SNAPSHOT_BATCH_SIZE)
          .all();
        if (batch.length === 0) break;
        const oldIds: string[] = [];

        for (const row of batch) {
          // Everything after the target in the same batch is post-target and
          // must not be copied.
          if (reached) break;
          if (row.id === input.sourceMessageId) reached = true;
          const newId = uuidv7();
          idMap.set(row.id, newId);
          oldIds.push(row.id);
          copied += 1;
          tx.insert(messages)
            .values({
              id: newId,
              chatId: childChatId,
              branchId,
              parentId: idMap.get(row.parentId ?? '') ?? null,
              role: row.role,
              content: row.content,
              name: row.name,
              // RAW TEXT copy — unknown meta fields survive verbatim.
              meta: row.meta,
              createdAt: row.createdAt,
              revision: 1,
              updatedAt: null,
              idempotencyKey: null,
              variantCount: row.variantCount,
              activeVariantPosition: row.activeVariantPosition,
              contentRevisionCount: row.contentRevisionCount,
              checkpointChatId: null,
            })
            .run();
        }

        const variants = tx
          .select()
          .from(messageVariants)
          .where(inArray(messageVariants.messageId, oldIds))
          .orderBy(asc(messageVariants.position), asc(messageVariants.createdAt))
          .all();
        for (const variant of variants) {
          const newMessageId = idMap.get(variant.messageId);
          if (!newMessageId) continue;
          tx.insert(messageVariants)
            .values({
              id: uuidv7(),
              messageId: newMessageId,
              position: variant.position,
              content: variant.content,
              createdAt: variant.createdAt,
            })
            .run();
        }

        const revisions = tx
          .select()
          .from(messageContentRevisions)
          .where(inArray(messageContentRevisions.messageId, oldIds))
          .orderBy(asc(messageContentRevisions.position), asc(messageContentRevisions.createdAt))
          .all();
        for (const revision of revisions) {
          const newMessageId = idMap.get(revision.messageId);
          if (!newMessageId) continue;
          tx.insert(messageContentRevisions)
            .values({
              id: uuidv7(),
              messageId: newMessageId,
              position: revision.position,
              content: revision.content,
              createdAt: revision.createdAt,
            })
            .run();
        }

        const blocks = tx
          .select()
          .from(messageBlockAttachments)
          .where(inArray(messageBlockAttachments.messageId, oldIds))
          .all();
        for (const block of blocks) {
          const newMessageId = idMap.get(block.messageId);
          if (!newMessageId) continue;
          tx.insert(messageBlockAttachments)
            .values({
              id: uuidv7(),
              messageId: newMessageId,
              pluginId: block.pluginId,
              blockType: block.blockType,
              rendererId: block.rendererId,
              descriptorJson: block.descriptorJson,
              serializedStateJson: block.serializedStateJson,
              createdAt: block.createdAt,
              updatedAt: block.updatedAt,
            })
            .run();
        }

        const last = batch[batch.length - 1];
        if (!last) break;
        cursorC = last.createdAt;
        cursorI = last.id;
        if (batch.length < SNAPSHOT_BATCH_SIZE) break;
      }
      // Unreachable given the branch check above; throwing rolls back the
      // partial copy so nothing half-snapshotted persists.
      if (!reached) throw new Error('SNAPSHOT_TARGET_UNREACHABLE');

      tx.update(chats).set({ messageCount: copied }).where(eq(chats.id, childChatId)).run();

      const child = tx.select().from(chats).where(eq(chats.id, childChatId)).get();
      if (!child) throw new Error('SNAPSHOT_CHILD_MISSING');
      return { chat: rowToChat(child), copiedMessages: copied };
    });
  }
}
