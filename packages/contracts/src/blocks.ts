/**
 * Message block attachment schemas (rev4 stage 4 — persistent blocks).
 *
 * A plugin attaches a block instance to a chat message; the attachment
 * (including the renderer's serialized state) is stored server-side so it
 * survives page reloads and renders identically in any client. The renderer
 * itself is host-side state (it only exists while the plugin session lives);
 * the attachment is durable data.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';

export const MessageBlockSchema = Type.Object({
  id: IdSchema,
  messageId: IdSchema,
  /** Owning plugin (cascade-deleted on uninstall). */
  pluginId: Type.String(),
  blockType: Type.String({ minLength: 1, maxLength: 100 }),
  rendererId: Type.String({ minLength: 1, maxLength: 200 }),
  /** Attach-time descriptor (immutable). */
  descriptor: Type.Unknown(),
  /** Renderer state captured on unmount; replayed on remount. */
  serializedState: Type.Optional(Type.Unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type MessageBlock = Static<typeof MessageBlockSchema>;

export const BlockAttachSchema = Type.Object({
  blockType: Type.String({ minLength: 1, maxLength: 100 }),
  rendererId: Type.String({ minLength: 1, maxLength: 200 }),
  pluginId: Type.String({ minLength: 1, maxLength: 200 }),
  descriptor: Type.Optional(Type.Unknown()),
});
export type BlockAttach = Static<typeof BlockAttachSchema>;

export const BlockUpdateSchema = Type.Object({
  descriptor: Type.Optional(Type.Unknown()),
  /** Omit to keep; pass `null` to clear the stored renderer state. */
  serializedState: Type.Optional(Type.Union([Type.Unknown(), Type.Null()])),
});
export type BlockUpdate = Static<typeof BlockUpdateSchema>;

export const BlockListSchema = Type.Object({
  items: Type.Array(MessageBlockSchema),
});
export type BlockList = Static<typeof BlockListSchema>;
