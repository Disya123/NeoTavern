/** Chat and message routes: /api/v2/chats. */
import {
  IdSchema,
  AckSchema,
  ChatCreateSchema,
  ChatSchema,
  ChatSummarySchema,
  ChatUpdateSchema,
  ChatListQuerySchema,
  ChatReorderSchema,
  ChatSnapshotCreateSchema,
  ChatSnapshotResultSchema,
  CursorPageSchema,
  MessageCreateSchema,
  MessageContentRevisionSchema,
  MessageRevisionListQuerySchema,
  MessageRevisionRestoreSchema,
  MessageDraftCommitResultSchema,
  MessageDraftCreateSchema,
  MessageDraftSchema,
  MessageDraftUpdateSchema,
  MessageListQuerySchema,
  MessageSchema,
  MessageUpdateSchema,
  MessageVariantSchema,
  SwipeActivateSchema,
  type Chat,
  type ChatSummary,
  type Message,
  type MessageUpdate,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import { resolveGreetingSelection } from '../lib/greetings.js';
import type { AppContext, TypedApp } from '../types.js';

function toSummary(
  c: Chat & { characterName?: string | null; characterAvatar?: string | null },
): ChatSummary {
  return {
    id: c.id,
    characterId: c.characterId,
    characterName: c.characterName ?? null,
    characterAvatar: c.characterAvatar ?? null,
    title: c.title,
    messageCount: c.messageCount,
    parentChatId: c.parentChatId,
    origin: c.origin,
    sourceMessageId: c.sourceMessageId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function isGreetingSwipePatch(existing: Message, patch: MessageUpdate): boolean {
  const swipes = patch.meta?.['swipes'];
  const swipeId = patch.meta?.['swipeId'];

  return (
    patch.content !== undefined &&
    existing.meta['greeting'] === true &&
    patch.meta?.['greeting'] === true &&
    Array.isArray(swipes) &&
    typeof swipeId === 'number' &&
    Number.isInteger(swipeId) &&
    swipes[swipeId] === patch.content
  );
}

export async function registerChatRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const chats = ctx.database.repos.chats;
  const messages = ctx.database.repos.messages;
  const messageDrafts = ctx.database.repos.messageDrafts;
  const characters = ctx.database.repos.characters;
  const snapshots = ctx.database.repos.snapshots;
  const pendingUnstartedCreates = new Map<string, Promise<Chat>>();

  app.get(
    '/api/v2/chats',
    {
      schema: {
        querystring: ChatListQuerySchema,
        response: { 200: CursorPageSchema(ChatSummarySchema) },
      },
    },
    async (req) => {
      const page = await chats.list(req.query);
      return {
        items: page.items.map(toSummary),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },
  );

  app.post(
    '/api/v2/chats',
    { schema: { body: ChatCreateSchema, response: { 200: ChatSchema } } },
    async (req) => {
      const character = req.body.characterId
        ? await characters.getById(req.body.characterId)
        : null;
      if (req.body.characterId && !character) {
        throw new AppError({
          code: ErrorCodes.CHARACTER_NOT_FOUND,
          params: { characterId: req.body.characterId },
        });
      }
      const initialGreeting = character
        ? resolveGreetingSelection(character, req.body.greetingIndex)
        : undefined;
      const createFresh = async (): Promise<Chat> => {
        const created = await chats.create(req.body, initialGreeting);
        ctx.events.emit('chat.created', { chatId: created.id });
        return created;
      };

      if (!req.body.reuseUnstarted) return createFresh();

      const characterId = req.body.characterId ?? null;
      const personaId = req.body.personaId ?? null;
      const pendingKey = `${characterId ?? ''}\u0000${personaId ?? ''}`;
      const pending = pendingUnstartedCreates.get(pendingKey);
      if (pending) return pending;

      const request = (async () => {
        const existing = await chats.findUnstarted(characterId, personaId);
        return existing ?? createFresh();
      })();
      pendingUnstartedCreates.set(pendingKey, request);
      try {
        return await request;
      } finally {
        if (pendingUnstartedCreates.get(pendingKey) === request) {
          pendingUnstartedCreates.delete(pendingKey);
        }
      }
    },
  );

  app.get(
    '/api/v2/chats/:id',
    {
      schema: { params: Type.Object({ id: IdSchema }), response: { 200: ChatSchema } },
    },
    async (req) => {
      const chat = await chats.getById(req.params.id);
      if (!chat)
        throw new AppError({ code: ErrorCodes.CHAT_NOT_FOUND, params: { chatId: req.params.id } });
      ctx.events.emit('chat.opened', { chatId: chat.id });
      // Opening a character chat selects that character (plugin-sdk
      // AppEventMap 'character.selected' — previously declared but never
      // emitted).
      if (chat.characterId) {
        ctx.events.emit('character.selected', { characterId: chat.characterId });
      }
      return chat;
    },
  );

  app.patch(
    '/api/v2/chats/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: ChatUpdateSchema,
        response: { 200: ChatSchema },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      if (
        req.body.activeBranchId !== undefined &&
        req.body.activeBranchId !== null &&
        !(await chats.listBranches(req.params.id)).some(
          (branch) => branch.id === req.body.activeBranchId,
        )
      ) {
        throw new AppError({
          code: ErrorCodes.CHAT_BRANCH_NOT_FOUND,
          params: { chatId: req.params.id, branchId: req.body.activeBranchId },
        });
      }
      const updated = await chats.update(req.params.id, req.body);
      if (!updated)
        throw new AppError({ code: ErrorCodes.CHAT_NOT_FOUND, params: { chatId: req.params.id } });
      return updated;
    },
  );

  app.delete(
    '/api/v2/chats/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        querystring: Type.Object({ purge: Type.Optional(Type.Boolean()) }),
        response: { 200: AckSchema },
      },
    },
    async (req) => {
      // Default is soft delete (trash); ?purge=true removes permanently.
      if (req.query.purge) await chats.hardDelete(req.params.id);
      else await chats.softDelete(req.params.id);
      return { ok: true };
    },
  );

  app.post(
    '/api/v2/chats/:id/restore',
    {
      schema: { params: Type.Object({ id: IdSchema }), response: { 200: AckSchema } },
    },
    async (req) => {
      const restored = await chats.restore(req.params.id);
      if (!restored)
        throw new AppError({ code: ErrorCodes.CHAT_NOT_FOUND, params: { chatId: req.params.id } });
      return { ok: true };
    },
  );

  app.get(
    '/api/v2/chats/:id/messages',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        querystring: MessageListQuerySchema,
        response: { 200: CursorPageSchema(MessageSchema) },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      if (req.query.branchId) {
        const branches = await chats.listBranches(req.params.id);
        if (!branches.some((branch) => branch.id === req.query.branchId)) {
          throw new AppError({
            code: ErrorCodes.CHAT_BRANCH_NOT_FOUND,
            params: { chatId: req.params.id, branchId: req.query.branchId },
          });
        }
      }
      return messages.list(req.params.id, req.query);
    },
  );

  app.post(
    '/api/v2/chats/:id/messages',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: MessageCreateSchema,
        response: { 200: MessageSchema },
      },
    },
    async (req) => {
      const chat = await requireChat(chats, req.params.id);
      const branch = chat.activeBranchId ?? (await chats.createBranch(chat.id, 'main'));
      if (!chat.activeBranchId) await chats.update(chat.id, { activeBranchId: branch });
      // idempotencyKey dedupes replayed creates in the repository (rev4
      // stage 3 outbox); a replay returns the original message.
      const message = await messages.create(req.params.id, branch, req.body);
      const count = await messages.count(req.params.id, branch);
      await chats.setMessageCount(req.params.id, count);
      ctx.events.emit('chat.message.created', {
        chatId: req.params.id,
        messageId: message.id,
        role: message.role,
      });
      return message;
    },
  );

  app.patch(
    '/api/v2/chats/:id/messages/:messageId',
    {
      schema: {
        params: Type.Object({ id: IdSchema, messageId: Type.String() }),
        body: MessageUpdateSchema,
        response: { 200: MessageSchema },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      const existing = await messages.getById(req.params.messageId);
      if (!existing || existing.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      const { expectedRevision, ...patch } = req.body;
      const result = await messages.update(req.params.messageId, patch, expectedRevision, {
        trackContentRevision: !isGreetingSwipePatch(existing, patch),
      });
      if (result.status === 'missing') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      if (result.status === 'conflict') {
        // The writer raced a concurrent edit (rev4 stage 3 CAS): report the
        // current revision instead of silently clobbering it.
        throw new AppError({
          code: ErrorCodes.MESSAGE_CONFLICT,
          params: {
            messageId: req.params.messageId,
            expectedRevision,
            currentRevision: result.currentRevision,
          },
        });
      }
      await chats.touch(req.params.id);
      ctx.events.emit('chat.message.updated', {
        chatId: req.params.id,
        messageId: result.message.id,
        role: result.message.role,
        revision: result.message.revision,
      });
      return result.message;
    },
  );

  app.get(
    '/api/v2/chats/:id/messages/:messageId/revisions',
    {
      schema: {
        params: Type.Object({ id: IdSchema, messageId: Type.String() }),
        querystring: MessageRevisionListQuerySchema,
        response: { 200: CursorPageSchema(MessageContentRevisionSchema) },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      const existing = await messages.getById(req.params.messageId);
      if (!existing || existing.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }

      return messages.listContentRevisions(req.params.messageId, req.query);
    },
  );

  app.post(
    '/api/v2/chats/:id/messages/:messageId/revisions/:revisionId/restore',
    {
      schema: {
        params: Type.Object({
          id: IdSchema,
          messageId: Type.String(),
          revisionId: Type.String(),
        }),
        body: MessageRevisionRestoreSchema,
        response: { 200: MessageSchema },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      const existing = await messages.getById(req.params.messageId);
      if (!existing || existing.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }

      const result = await messages.restoreContentRevision(
        req.params.messageId,
        req.params.revisionId,
        req.body.expectedRevision,
      );
      if (result.status === 'missing') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      if (result.status === 'revision-missing') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_REVISION_NOT_FOUND,
          params: {
            messageId: req.params.messageId,
            revisionId: req.params.revisionId,
          },
        });
      }
      if (result.status === 'conflict') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_CONFLICT,
          params: {
            messageId: req.params.messageId,
            expectedRevision: req.body.expectedRevision,
            currentRevision: result.currentRevision,
          },
        });
      }

      await chats.touch(req.params.id);
      ctx.events.emit('chat.message.updated', {
        chatId: req.params.id,
        messageId: result.message.id,
        role: result.message.role,
        revision: result.message.revision,
      });
      return result.message;
    },
  );

  app.delete(
    '/api/v2/chats/:id/messages/:messageId',
    {
      schema: {
        params: Type.Object({ id: IdSchema, messageId: Type.String() }),
        response: { 200: AckSchema },
      },
    },
    async (req) => {
      const chat = await requireChat(chats, req.params.id);
      const existing = await messages.getById(req.params.messageId);
      if (!existing || existing.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      await messages.delete(req.params.messageId);
      if (chat.activeBranchId) {
        const count = await messages.count(req.params.id, chat.activeBranchId);
        await chats.setMessageCount(req.params.id, count);
      }
      ctx.events.emit('chat.message.deleted', {
        chatId: req.params.id,
        messageId: req.params.messageId,
      });
      return { ok: true };
    },
  );

  // ── Draft / streaming messages (rev4 stage 3) ──────────────────────────
  //
  // Streaming writers stream into a server-side draft; only `commit`
  // materializes a real message. The flush rate (10 Hz) is the writer's
  // internal policy, `sequence` makes replayed PATCHes idempotent no-ops and
  // `commit` is retry-safe (alreadyCommitted). A crashed writer leaves a
  // swept draft row — never a half-written committed message.

  app.post(
    '/api/v2/chats/:id/drafts',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: MessageDraftCreateSchema,
        response: { 200: MessageDraftSchema },
      },
    },
    async (req) => {
      const chat = await requireChat(chats, req.params.id);
      const branch = chat.activeBranchId ?? (await chats.createBranch(chat.id, 'main'));
      if (!chat.activeBranchId) await chats.update(chat.id, { activeBranchId: branch });
      return messageDrafts.create(req.params.id, branch, req.body);
    },
  );

  app.patch(
    '/api/v2/chats/:id/drafts/:draftId',
    {
      schema: {
        params: Type.Object({ id: IdSchema, draftId: Type.String() }),
        body: MessageDraftUpdateSchema,
        response: { 200: MessageDraftSchema },
      },
    },
    async (req) => {
      const draft = await messageDrafts.getById(req.params.draftId);
      if (!draft || draft.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_DRAFT_NOT_FOUND,
          params: { draftId: req.params.draftId },
        });
      }
      // A stale sequence (≤ stored) is an idempotent no-op that still
      // returns the draft — retries after reconnect never duplicate writes.
      const result = await messageDrafts.update(req.params.draftId, req.body);
      if (result.status === 'missing') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_DRAFT_NOT_FOUND,
          params: { draftId: req.params.draftId },
        });
      }
      return result.draft;
    },
  );

  app.post(
    '/api/v2/chats/:id/drafts/:draftId/commit',
    {
      schema: {
        params: Type.Object({ id: IdSchema, draftId: Type.String() }),
        response: { 200: MessageDraftCommitResultSchema },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      const outcome = await messageDrafts.commit(req.params.draftId);
      if (outcome.status === 'missing') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_DRAFT_NOT_FOUND,
          params: { draftId: req.params.draftId },
        });
      }
      if (!outcome.result.alreadyCommitted && outcome.message) {
        const count = await messages.count(req.params.id, outcome.message.branchId);
        await chats.setMessageCount(req.params.id, count);
        ctx.events.emit('chat.message.created', {
          chatId: req.params.id,
          messageId: outcome.message.id,
          role: outcome.message.role,
        });
      }
      return outcome.result;
    },
  );

  app.delete(
    '/api/v2/chats/:id/drafts/:draftId',
    {
      schema: {
        params: Type.Object({ id: IdSchema, draftId: Type.String() }),
        response: { 200: AckSchema },
      },
    },
    async (req) => {
      const draft = await messageDrafts.getById(req.params.draftId);
      if (!draft || draft.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_DRAFT_NOT_FOUND,
          params: { draftId: req.params.draftId },
        });
      }
      await messageDrafts.abort(req.params.draftId);
      return { ok: true };
    },
  );

  app.post(
    '/api/v2/chats/:id/messages/:messageId/swipe',
    {
      schema: {
        params: Type.Object({ id: IdSchema, messageId: Type.String() }),
        body: SwipeActivateSchema,
        response: { 200: MessageSchema },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      const existing = await messages.getById(req.params.messageId);
      if (!existing || existing.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      const result = await messages.setActiveVariant(
        req.params.messageId,
        req.body.position,
        req.body.expectedRevision,
      );
      if (result.status === 'missing') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      if (result.status === 'conflict') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_CONFLICT,
          params: {
            messageId: req.params.messageId,
            expectedRevision: req.body.expectedRevision,
            currentRevision: result.currentRevision,
          },
        });
      }
      await chats.touch(req.params.id);
      ctx.events.emit('chat.message.updated', {
        chatId: req.params.id,
        messageId: result.message.id,
        role: result.message.role,
        revision: result.message.revision,
      });
      return result.message;
    },
  );

  app.get(
    '/api/v2/chats/:id/messages/:messageId/variants',
    {
      schema: {
        params: Type.Object({ id: IdSchema, messageId: Type.String() }),
        response: { 200: Type.Object({ items: Type.Array(MessageVariantSchema) }) },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      const message = await messages.getById(req.params.messageId);
      if (!message || message.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      return { items: await messages.listVariants(req.params.messageId) };
    },
  );

  app.post(
    '/api/v2/chats/:id/messages/:messageId/variants/:variantId/activate',
    {
      schema: {
        params: Type.Object({
          id: IdSchema,
          messageId: Type.String(),
          variantId: Type.String(),
        }),
        // Optional body: the legacy activate call carried no payload; the
        // optional CAS guard was added later and must not break old clients.
        // Fastify validates undefined bodies as null — accept it explicitly.
        body: Type.Union([
          Type.Object({
            expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
          }),
          Type.Null(),
        ]),
        response: { 200: MessageSchema },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      const existing = await messages.getById(req.params.messageId);
      if (!existing || existing.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      const result = await messages.activateVariant(
        req.params.messageId,
        req.params.variantId,
        req.body?.expectedRevision,
      );
      if (result.status === 'missing') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.params.messageId },
        });
      }
      if (result.status === 'conflict') {
        throw new AppError({
          code: ErrorCodes.MESSAGE_CONFLICT,
          params: {
            messageId: req.params.messageId,
            expectedRevision: req.body?.expectedRevision,
            currentRevision: result.currentRevision,
          },
        });
      }
      await chats.touch(req.params.id);
      ctx.events.emit('chat.message.updated', {
        chatId: req.params.id,
        messageId: result.message.id,
        role: result.message.role,
        revision: result.message.revision,
      });
      return result.message;
    },
  );

  app.post(
    '/api/v2/chats/:id/snapshots',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: ChatSnapshotCreateSchema,
        response: { 200: ChatSnapshotResultSchema },
      },
    },
    async (req) => {
      const chat = await requireChat(chats, req.params.id);
      const source = await messages.getById(req.body.messageId);
      if (!source || source.chatId !== req.params.id) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.body.messageId },
        });
      }
      // A snapshot freezes the ACTIVE branch prefix; branching off an
      // inactive branch is refused (callers must switch branches first).
      if (!chat.activeBranchId || chat.activeBranchId !== source.branchId) {
        throw new AppError({
          code: ErrorCodes.CHAT_BRANCH_NOT_FOUND,
          params: { chatId: req.params.id, branchId: chat.activeBranchId ?? null },
        });
      }
      const snapshot = await snapshots.createSnapshot({
        parentChatId: req.params.id,
        sourceMessageId: req.body.messageId,
        kind: req.body.kind,
        title: req.body.title,
      });
      if (!snapshot) {
        throw new AppError({
          code: ErrorCodes.MESSAGE_NOT_FOUND,
          params: { messageId: req.body.messageId },
        });
      }
      if (req.body.kind === 'checkpoint') {
        // Repoint the source message's checkpoint flag at the fresh child
        // chat (replace semantics; the previous child chat is never deleted).
        await messages.linkCheckpoint(req.body.messageId, snapshot.chat.id);
        const linked = await messages.getById(req.body.messageId);
        if (linked) {
          ctx.events.emit('chat.message.updated', {
            chatId: req.params.id,
            messageId: linked.id,
            role: linked.role,
            revision: linked.revision,
          });
        }
      }
      ctx.events.emit('chat.created', { chatId: snapshot.chat.id });
      return { chat: snapshot.chat, copiedMessages: snapshot.copiedMessages };
    },
  );

  app.get(
    '/api/v2/chats/:id/branches',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: {
          200: Type.Object({
            branches: Type.Array(Type.Object({ id: IdSchema, name: Type.String() })),
          }),
        },
      },
    },
    async (req) => {
      await requireChat(chats, req.params.id);
      return { branches: await chats.listBranches(req.params.id) };
    },
  );

  app.put(
    '/api/v2/chats/order',
    {
      schema: {
        body: ChatReorderSchema,
        response: {
          200: Type.Object({
            reordered: Type.Integer({ minimum: 0 }),
            invalidIds: Type.Array(IdSchema),
          }),
        },
      },
    },
    async (req) => {
      const character = await characters.getById(req.body.characterId);
      if (!character) {
        throw new AppError({
          code: ErrorCodes.CHARACTER_NOT_FOUND,
          params: { characterId: req.body.characterId },
        });
      }
      const result = await chats.reorder(req.body.characterId, req.body.order);
      if (result.invalidIds.length > 0) {
        throw new AppError({
          code: ErrorCodes.CHAT_NOT_FOUND,
          params: { chatId: result.invalidIds[0] },
        });
      }
      return result;
    },
  );

  app.get(
    '/api/v2/chats/:id/export',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
      },
    },
    async (req, reply) => {
      const chat = await requireChat(chats, req.params.id);
      const characterName = chat.characterId
        ? ((await characters.getById(chat.characterId))?.name ?? null)
        : null;
      const [exportedMessages, messageVariants, messageRevisions] = await Promise.all([
        messages.exportAll(chat.id),
        messages.exportVariants(chat.id),
        messages.exportContentRevisions(chat.id),
      ]);
      const payload = {
        kind: 'neotavern-chat-export',
        version: 2,
        exportedAt: Date.now(),
        chat,
        characterName,
        messages: exportedMessages,
        messageVariants,
        messageRevisions,
      };
      return reply
        .type('application/json')
        .header('Content-Disposition', `attachment; filename="chat-${chat.id}.json"`)
        .send(payload);
    },
  );
}

async function requireChat(
  chats: AppContext['database']['repos']['chats'],
  id: string,
): Promise<Chat> {
  const chat = await chats.getById(id);
  if (!chat) throw new AppError({ code: ErrorCodes.CHAT_NOT_FOUND, params: { chatId: id } });
  return chat;
}
