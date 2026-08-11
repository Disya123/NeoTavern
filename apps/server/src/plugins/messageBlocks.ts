/**
 * Message block attachments (rev4 stage 4): durable plugin→message bindings.
 *
 * The host kernel CRUDs these on behalf of sandboxed plugins (capability
 * `ui.messageBlock` is checked host-side); this plugin owns persistence and
 * the `chat.message.block.changed` event so other clients reload a message's
 * blocks when they change.
 */
import { Type } from '@sinclair/typebox';
import {
  BlockAttachSchema,
  BlockListSchema,
  BlockUpdateSchema,
  MessageBlockSchema,
  type MessageBlock,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import type { AppContext, TypedApp } from '../types.js';

const MAX_BATCH_MESSAGE_IDS = 100;

async function requireChat(ctx: AppContext, chatId: string): Promise<void> {
  const chat = await ctx.database.repos.chats.getById(chatId);
  if (!chat) {
    throw new AppError({ code: ErrorCodes.CHAT_NOT_FOUND, params: { chatId } });
  }
}

/** Verify the block exists (the host only knows blockId, not its chat). */
async function requireBlock(
  ctx: AppContext,
  blockId: string,
): Promise<{ block: MessageBlock; chatId: string }> {
  const block = await ctx.database.repos.messageBlocks.getById(blockId);
  if (!block) {
    throw new AppError({ code: ErrorCodes.MESSAGE_NOT_FOUND, params: { messageId: blockId } });
  }
  const message = await ctx.database.repos.messages.getById(block.messageId);
  if (!message) {
    throw new AppError({ code: ErrorCodes.MESSAGE_NOT_FOUND, params: { messageId: blockId } });
  }
  return { block, chatId: message.chatId };
}

export async function registerMessageBlockRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const blocks = ctx.database.repos.messageBlocks;
  const messages = ctx.database.repos.messages;

  // Batch read for a page of messages (one query, no N+1).
  app.get(
    '/api/v2/chats/:id/blocks',
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
        querystring: Type.Object({ messageIds: Type.String({ minLength: 1 }) }),
        response: { 200: BlockListSchema },
      },
    },
    async (req) => {
      await requireChat(ctx, req.params.id);
      const requested = req.query.messageIds
        .split(',')
        .slice(0, MAX_BATCH_MESSAGE_IDS)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      // Only attachments of messages that actually belong to this chat.
      const owned = await messages.listIdsInChat(req.params.id, requested);
      return { items: await blocks.listByMessages(owned) };
    },
  );

  app.post(
    '/api/v2/chats/:id/messages/:messageId/blocks',
    {
      schema: {
        params: Type.Object({ id: Type.String(), messageId: Type.String() }),
        body: BlockAttachSchema,
        response: { 200: MessageBlockSchema },
      },
    },
    async (req) => {
      await requireChat(ctx, req.params.id);
      const message = await messages.getById(req.params.messageId);
      if (!message || message.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      const created = await blocks.create(req.params.messageId, req.body);
      ctx.events.emit('chat.message.block.changed', {
        chatId: req.params.id,
        messageId: req.params.messageId,
        blockId: created.id,
      });
      return created;
    },
  );

  app.patch(
    '/api/v2/blocks/:blockId',
    {
      schema: {
        params: Type.Object({ blockId: Type.String() }),
        body: BlockUpdateSchema,
        response: { 200: MessageBlockSchema },
      },
    },
    async (req) => {
      const existing = await requireBlock(ctx, req.params.blockId);
      const updated = await blocks.update(req.params.blockId, req.body);
      if (!updated) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.blockId },
        });
      }
      ctx.events.emit('chat.message.block.changed', {
        chatId: existing.chatId,
        messageId: existing.block.messageId,
        blockId: req.params.blockId,
      });
      return updated;
    },
  );

  app.delete(
    '/api/v2/blocks/:blockId',
    {
      schema: {
        params: Type.Object({ blockId: Type.String() }),
        response: { 200: Type.Object({ ok: Type.Boolean() }) },
      },
    },
    async (req) => {
      const existing = await requireBlock(ctx, req.params.blockId);
      await blocks.delete(req.params.blockId);
      ctx.events.emit('chat.message.block.changed', {
        chatId: existing.chatId,
        messageId: existing.block.messageId,
        blockId: req.params.blockId,
      });
      return { ok: true };
    },
  );
}
