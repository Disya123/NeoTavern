/**
 * Checkpoint / branch snapshot contracts (ST1 message actions).
 *
 * A snapshot copies the active-branch prefix of a chat up to a chosen message
 * into a fresh child chat. `checkpoint` snapshots additionally flag the source
 * message with the child chat's id (`messages.checkpoint_chat_id`); `branch`
 * snapshots are independent working copies. Swiping activates a stored
 * variant of a message by its 0-based position.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema } from './common.js';
import { ChatSchema } from './chat.js';

export const ChatSnapshotOriginSchema = Type.Union([
  Type.Literal('checkpoint'),
  Type.Literal('branch'),
]);
export type ChatSnapshotOrigin = Static<typeof ChatSnapshotOriginSchema>;

/** Body for POST /api/v2/chats/:id/snapshots. */
export const ChatSnapshotCreateSchema = Type.Object({
  messageId: IdSchema,
  kind: ChatSnapshotOriginSchema,
  /** Repoint the source message's checkpoint link to the fresh snapshot. */
  replace: Type.Optional(Type.Boolean()),
  title: Type.Optional(Type.String({ maxLength: 500 })),
});
export type ChatSnapshotCreate = Static<typeof ChatSnapshotCreateSchema>;

export const ChatSnapshotResultSchema = Type.Object({
  chat: ChatSchema,
  copiedMessages: Type.Integer({ minimum: 0 }),
});
export type ChatSnapshotResult = Static<typeof ChatSnapshotResultSchema>;

/** Body for POST /api/v2/chats/:id/messages/:messageId/swipe. */
export const SwipeActivateSchema = Type.Object({
  /** Stored-variant position to make active (0-based). */
  position: Type.Integer({ minimum: 0 }),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type SwipeActivate = Static<typeof SwipeActivateSchema>;
