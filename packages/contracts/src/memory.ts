/**
 * Memory/RAG contracts (ТЗ §4.4). Memories are long-lived knowledge fragments
 * the pipeline injects into the prompt: global facts or character-scoped ones,
 * activated by keyword match against the conversation context.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';

export const MemoryScopeSchema = Type.Union([Type.Literal('global'), Type.Literal('character')]);
export type MemoryScope = Static<typeof MemoryScopeSchema>;

export const MemorySchema = Type.Object({
  id: IdSchema,
  scope: MemoryScopeSchema,
  characterId: Type.Union([IdSchema, Type.Null()]),
  /** Activation keywords (case-insensitive substring match). */
  keys: Type.Array(Type.String()),
  content: Type.String(),
  enabled: Type.Boolean(),
  /** Author ordering used as the retrieval tie-break. */
  position: Type.Integer(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Memory = Static<typeof MemorySchema>;

export const MemoryCreateSchema = Type.Object({
  scope: Type.Optional(MemoryScopeSchema),
  characterId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  keys: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 100 })),
  content: Type.String({ minLength: 1, maxLength: 100000 }),
  enabled: Type.Optional(Type.Boolean()),
  position: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type MemoryCreate = Static<typeof MemoryCreateSchema>;

export const MemoryUpdateSchema = Type.Partial(MemoryCreateSchema);
export type MemoryUpdate = Static<typeof MemoryUpdateSchema>;

export const MemoryListQuerySchema = Type.Object({
  scope: Type.Optional(MemoryScopeSchema),
  characterId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  enabled: Type.Optional(Type.Boolean()),
});
export type MemoryListQuery = Static<typeof MemoryListQuerySchema>;
