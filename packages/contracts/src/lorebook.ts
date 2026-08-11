/**
 * Lorebook (world info) schemas. A lorebook holds keyword-activated entries
 * injected into the prompt pipeline at the Lorebook stage (ТЗ §4.4, §12).
 *
 * Books are standalone or linked to a character via `characterId`. Retrieval
 * during generation considers the character's books plus all global books
 * (those without a character link).
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';

export const LorebookEntrySchema = Type.Object({
  id: IdSchema,
  lorebookId: IdSchema,
  /** Primary activation keywords (case-insensitive substring match). */
  keys: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }),
  /** Secondary keywords; required too when `selective` is true. */
  secondaryKeys: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }),
  content: Type.String(),
  enabled: Type.Boolean(),
  /** Ordering hint inside the book (lower first). */
  position: Type.Integer(),
  /** Constant entries are always injected (required blocks). */
  constant: Type.Boolean(),
  /** Selective entries need a primary AND a secondary key match. */
  selective: Type.Boolean(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type LorebookEntry = Static<typeof LorebookEntrySchema>;

export const LorebookSchema = Type.Object({
  id: IdSchema,
  name: Type.String(),
  description: Type.String(),
  /** Owning character, or null for a global book. */
  characterId: Type.Union([IdSchema, Type.Null()]),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Lorebook = Static<typeof LorebookSchema>;

export const LorebookEntryCreateSchema = Type.Object(
  {
    keys: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      minItems: 1,
      maxItems: 100,
    }),
    secondaryKeys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }),
    ),
    content: Type.String({ minLength: 1, maxLength: 20_000 }),
    enabled: Type.Optional(Type.Boolean()),
    position: Type.Optional(Type.Integer({ minimum: -1_000_000, maximum: 1_000_000 })),
    constant: Type.Optional(Type.Boolean()),
    selective: Type.Optional(Type.Boolean()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type LorebookEntryCreate = Static<typeof LorebookEntryCreateSchema>;

export const LorebookEntryUpdateSchema = Type.Partial(LorebookEntryCreateSchema);
export type LorebookEntryUpdate = Static<typeof LorebookEntryUpdateSchema>;

export const LorebookCreateSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 500 }),
    description: Type.Optional(Type.String({ maxLength: 5000 })),
    characterId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
    entries: Type.Optional(Type.Array(LorebookEntryCreateSchema, { maxItems: 1000 })),
  },
  { additionalProperties: false },
);
export type LorebookCreate = Static<typeof LorebookCreateSchema>;

export const LorebookUpdateSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    description: Type.Optional(Type.String({ maxLength: 5000 })),
    characterId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
export type LorebookUpdate = Static<typeof LorebookUpdateSchema>;
