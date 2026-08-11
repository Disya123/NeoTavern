/**
 * Chat (conversation) schemas. A chat references an optional character and
 * persona, has a title, an active branch, and a rolling summary used by the
 * context-shifting stage of the prompt pipeline.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';

export const ChatSchema = Type.Object({
  id: IdSchema,
  characterId: Type.Union([IdSchema, Type.Null()]),
  personaId: Type.Union([IdSchema, Type.Null()]),
  title: Type.String(),
  activeBranchId: Type.Union([IdSchema, Type.Null()]),
  backgroundId: Type.Union([Type.String({ minLength: 1, maxLength: 255 }), Type.Null()]),
  summary: Type.String(),
  messageCount: Type.Integer({ minimum: 0 }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: Type.Union([TimestampSchema, Type.Null()]),
  /** Chat this one was snapshotted from (checkpoint/branch child chats). */
  parentChatId: Type.Union([IdSchema, Type.Null()]),
  /** How this chat was created: a checkpoint or branch snapshot of a parent. */
  origin: Type.Union([Type.Literal('checkpoint'), Type.Literal('branch'), Type.Null()]),
  /** Message in the parent chat the snapshot was taken at. */
  sourceMessageId: Type.Union([IdSchema, Type.Null()]),
});
export type Chat = Static<typeof ChatSchema>;

export const ChatSummarySchema = Type.Object({
  id: IdSchema,
  characterId: Type.Union([IdSchema, Type.Null()]),
  /** Character identity included by the REST chat catalog when available. */
  characterName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Character avatar included by the REST chat catalog when available. */
  characterAvatar: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  title: Type.String(),
  messageCount: Type.Integer({ minimum: 0 }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Snapshot provenance (catalog badge): parent chat, origin, source message. */
  parentChatId: Type.Union([IdSchema, Type.Null()]),
  origin: Type.Union([Type.Literal('checkpoint'), Type.Literal('branch'), Type.Null()]),
  sourceMessageId: Type.Union([IdSchema, Type.Null()]),
});
export type ChatSummary = Static<typeof ChatSummarySchema>;

export const ChatCreateSchema = Type.Object({
  characterId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  personaId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  title: Type.Optional(Type.String({ maxLength: 500 })),
  /**
   * Index into the character's authored greetings
   * (`firstMessage` + `ext.alternateGreetings`). Defaults to `0`.
   */
  greetingIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
  /**
   * Frontend new-chat guard. When enabled, the API returns the most recently
   * updated live chat for the same character if it has no user messages,
   * instead of creating another greeting-only conversation.
   */
  reuseUnstarted: Type.Optional(Type.Boolean()),
  /** Snapshot provenance; set by the snapshot repository (checkpoint/branch). */
  parentChatId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  origin: Type.Optional(
    Type.Union([Type.Literal('checkpoint'), Type.Literal('branch'), Type.Null()]),
  ),
  sourceMessageId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
});
export type ChatCreate = Static<typeof ChatCreateSchema>;

export const ChatUpdateSchema = Type.Object({
  title: Type.Optional(Type.String({ maxLength: 500 })),
  personaId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  activeBranchId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  /**
   * Stored background filename (`data/files/backgrounds/`) or `null` to fall
   * back to the theme wallpaper. Referenced file may not exist — the UI then
   * keeps the theme default.
   */
  backgroundId: Type.Optional(
    Type.Union([Type.String({ minLength: 1, maxLength: 255 }), Type.Null()]),
  ),
  summary: Type.Optional(Type.String()),
});
export type ChatUpdate = Static<typeof ChatUpdateSchema>;

export const ChatListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  characterId: Type.Optional(IdSchema),
  /** Recent order ignores the manual sidebar order. */
  sort: Type.Optional(Type.Union([Type.Literal('manual'), Type.Literal('recent')])),
  /**
   * Full-text search over chat titles/summaries AND message content. When a
   * `characterId` is also given the match is limited to that character.
   */
  q: Type.Optional(Type.String()),
});
export type ChatListQuery = Static<typeof ChatListQuerySchema>;

/**
 * Body for PUT /api/v2/chats/order — persist a manual drag-and-drop ordering
 * of a character's chats. `order` may be a partial list; chats not listed keep
 * their relative position below the reordered block.
 */
export const ChatReorderSchema = Type.Object({
  characterId: IdSchema,
  order: Type.Array(IdSchema, { maxItems: 5000 }),
});
export type ChatReorder = Static<typeof ChatReorderSchema>;
