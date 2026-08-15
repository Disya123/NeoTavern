/**
 * Character card schemas.
 *
 * Unknown character-card fields and extension metadata are preserved in `ext`
 * and survive export/import (ТЗ §10.2). IDs are stable strings, never array
 * indexes. Deletion is soft (`deletedAt`).
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';

/** Full character representation. */
export const CharacterSchema = Type.Object({
  id: IdSchema,
  name: Type.String({ minLength: 1 }),
  avatar: Type.Union([Type.String(), Type.Null()]),
  /** Canonical asset reference (kernel plane); the legacy plane has no asset store. */
  avatarAssetId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: Type.String(),
  personality: Type.String(),
  scenario: Type.String(),
  firstMessage: Type.String(),
  exampleDialogues: Type.String(),
  systemPrompt: Type.Union([Type.String(), Type.Null()]),
  postHistoryInstructions: Type.Union([Type.String(), Type.Null()]),
  creator: Type.Union([Type.String(), Type.Null()]),
  creatorNotes: Type.Union([Type.String(), Type.Null()]),
  tags: Type.Array(Type.String()),
  /** Preserved unknown fields / extension metadata. */
  ext: Type.Record(Type.String(), Type.Unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Last time the character was used in a chat (epoch ms), for usage sorting. */
  lastUsedAt: Type.Union([TimestampSchema, Type.Null()]),
  deletedAt: Type.Union([TimestampSchema, Type.Null()]),
});
export type Character = Static<typeof CharacterSchema>;

/** Stored character snapshot (version history, ТЗ §10.2 character_versions). */
export const CharacterVersionSchema = Type.Object({
  id: IdSchema,
  characterId: IdSchema,
  version: Type.Integer({ minimum: 1 }),
  createdAt: TimestampSchema,
});
export type CharacterVersion = Static<typeof CharacterVersionSchema>;

/** Lightweight summary used in virtualized catalog lists. */
export const CharacterSummarySchema = Type.Object({
  id: IdSchema,
  name: Type.String(),
  avatar: Type.Union([Type.String(), Type.Null()]),
  /** Canonical asset reference (kernel plane); `null` on the legacy plane. */
  avatarAssetId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: Type.String(),
  tags: Type.Array(Type.String()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type CharacterSummary = Static<typeof CharacterSummarySchema>;

/** Creation input — only name is required. */
export const CharacterCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 500 }),
  avatar: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Canonical avatar asset reference (kernel plane; `avatar` stays the
   * legacy URL slot). `null`/absent means "no avatar asset". */
  avatarAssetId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: Type.Optional(Type.String()),
  personality: Type.Optional(Type.String()),
  scenario: Type.Optional(Type.String()),
  firstMessage: Type.Optional(Type.String()),
  exampleDialogues: Type.Optional(Type.String()),
  systemPrompt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  postHistoryInstructions: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  creator: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  creatorNotes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  tags: Type.Optional(Type.Array(Type.String())),
  ext: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type CharacterCreate = Static<typeof CharacterCreateSchema>;

/** Partial update input. */
export const CharacterUpdateSchema = Type.Partial(CharacterCreateSchema);
export type CharacterUpdate = Static<typeof CharacterUpdateSchema>;

/** Result of an idempotent character-card import. */
export const CharacterImportResultSchema = Type.Object({
  character: CharacterSchema,
  created: Type.Boolean(),
  sourceHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  warnings: Type.Array(Type.String()),
});
export type CharacterImportResult = Static<typeof CharacterImportResultSchema>;

/** Image stored in a character-owned gallery. Originals remain content-addressed on disk. */
export const CharacterGalleryImageSchema = Type.Object({
  id: IdSchema,
  characterId: IdSchema,
  name: Type.String(),
  mime: Type.String(),
  sizeBytes: Type.Integer({ minimum: 0 }),
  originalUrl: Type.String(),
  thumbnailUrl: Type.String(),
  createdAt: TimestampSchema,
});
export type CharacterGalleryImage = Static<typeof CharacterGalleryImageSchema>;

/** Character gallery response, ordered explicitly by the caller. */
export const CharacterGallerySchema = Type.Object({
  items: Type.Array(CharacterGalleryImageSchema),
});
export type CharacterGallery = Static<typeof CharacterGallerySchema>;

/** Portable Character Card V2 representation returned by export. */
export const CharacterCardV2Schema = Type.Object({
  spec: Type.Literal('chara_card_v2'),
  spec_version: Type.Literal('2.0'),
  data: Type.Object({
    name: Type.String(),
    description: Type.String(),
    personality: Type.String(),
    scenario: Type.String(),
    first_mes: Type.String(),
    mes_example: Type.String(),
    creator_notes: Type.String(),
    system_prompt: Type.String(),
    post_history_instructions: Type.String(),
    alternate_greetings: Type.Array(Type.String()),
    tags: Type.Array(Type.String()),
    creator: Type.String(),
    character_version: Type.String(),
    extensions: Type.Record(Type.String(), Type.Unknown()),
  }),
});
export type CharacterCardV2 = Static<typeof CharacterCardV2Schema>;

/** Character list query: cursor pagination + tag filter + free-text search. */
export const CharacterListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  tag: Type.Optional(Type.String()),
  q: Type.Optional(Type.String()),
  sort: Type.Optional(
    Type.Union([
      // Canonical sort values for the character browser (migration 0012).
      Type.Literal('name'),
      Type.Literal('name-desc'),
      Type.Literal('newest'),
      Type.Literal('oldest'),
      Type.Literal('favorites'),
      Type.Literal('used'),
      Type.Literal('chats-most'),
      Type.Literal('chats-least'),
      Type.Literal('tokens-most'),
      Type.Literal('tokens-least'),
      Type.Literal('random'),
      Type.Literal('relevance'),
      // Deprecated aliases kept for backward compatibility — mapped by the
      // repository to `newest` / `oldest` / `used` respectively.
      Type.Literal('recent'),
      Type.Literal('created'),
      Type.Literal('usage'),
    ]),
  ),
  includeDeleted: Type.Optional(Type.Boolean()),
});
export type CharacterListQuery = Static<typeof CharacterListQuerySchema>;
