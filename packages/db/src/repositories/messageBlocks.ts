/**
 * Message block attachments repository (rev4 stage 4).
 *
 * Durable plugin→message block bindings incl. serialized renderer state.
 * All writes are small and indexed by message; reads batch by message ids
 * so a chat page loads its blocks in one query.
 */
import { eq, inArray } from 'drizzle-orm';
import type { BlockAttach, BlockUpdate, MessageBlock } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { messageBlockAttachments } from '../schema/index.js';
import { parseJson, toJson } from '../json.js';

type BlockRow = typeof messageBlockAttachments.$inferSelect;

function rowToBlock(row: BlockRow): MessageBlock {
  return {
    id: row.id,
    messageId: row.messageId,
    pluginId: row.pluginId,
    blockType: row.blockType,
    rendererId: row.rendererId,
    descriptor: parseJson<unknown>(row.descriptorJson, {}),
    ...(row.serializedStateJson !== null
      ? { serializedState: parseJson<unknown>(row.serializedStateJson, null) }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class MessageBlockRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  async create(messageId: string, input: BlockAttach): Promise<MessageBlock> {
    const now = this.clock();
    const row = this.db
      .insert(messageBlockAttachments)
      .values({
        id: uuidv7(),
        messageId,
        pluginId: input.pluginId,
        blockType: input.blockType,
        rendererId: input.rendererId,
        descriptorJson: toJson(input.descriptor ?? {}),
        serializedStateJson: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return rowToBlock(row);
  }

  async getById(id: string): Promise<MessageBlock | null> {
    const row = await this.db
      .select()
      .from(messageBlockAttachments)
      .where(eq(messageBlockAttachments.id, id))
      .get();
    return row ? rowToBlock(row) : null;
  }

  /** All attachments of one message, in attach order. */
  async listByMessage(messageId: string): Promise<MessageBlock[]> {
    const rows = await this.db
      .select()
      .from(messageBlockAttachments)
      .where(eq(messageBlockAttachments.messageId, messageId))
      .orderBy(messageBlockAttachments.createdAt, messageBlockAttachments.id)
      .all();
    return rows.map(rowToBlock);
  }

  /** Batch read for a page of messages (single query, no N+1). */
  async listByMessages(messageIds: string[]): Promise<MessageBlock[]> {
    if (messageIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(messageBlockAttachments)
      .where(inArray(messageBlockAttachments.messageId, messageIds))
      .orderBy(messageBlockAttachments.createdAt, messageBlockAttachments.id)
      .all();
    return rows.map(rowToBlock);
  }

  /**
   * Update descriptor and/or renderer state. `serializedState: null`
   * explicitly clears the stored state; omitting it keeps the current value.
   */
  async update(id: string, patch: BlockUpdate): Promise<MessageBlock | null> {
    const values: Partial<BlockRow> = {};
    if (patch.descriptor !== undefined) values.descriptorJson = toJson(patch.descriptor);
    if (patch.serializedState !== undefined) {
      values.serializedStateJson =
        patch.serializedState === null ? null : toJson(patch.serializedState);
    }
    if (Object.keys(values).length === 0) return this.getById(id);
    values.updatedAt = this.clock();
    const row = await this.db
      .update(messageBlockAttachments)
      .set(values)
      .where(eq(messageBlockAttachments.id, id))
      .returning()
      .get();
    return row ? rowToBlock(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(messageBlockAttachments)
      .where(eq(messageBlockAttachments.id, id))
      .run();
    return result.changes > 0;
  }

  /** Uninstall cleanup: drop every attachment of a removed plugin. */
  async deleteByPlugin(pluginId: string): Promise<number> {
    const result = await this.db
      .delete(messageBlockAttachments)
      .where(eq(messageBlockAttachments.pluginId, pluginId))
      .run();
    return result.changes;
  }
}
