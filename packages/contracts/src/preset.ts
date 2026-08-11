/**
 * Preset schemas: saved configurations for generation, instruct formats,
 * context templates, etc. (ТЗ §10.2). `kind` partitions presets; `data` is a
 * free-form JSON payload validated by the consumer of that kind.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';
import { CONTEXT_TOKEN_MIN, CONTEXT_TOKEN_UNLOCKED_MAX } from './limits.js';
import { GenerationDefaultsSchema } from './provider.js';

export const PresetKindSchema = Type.String({
  minLength: 1,
  maxLength: 50,
  pattern: '^[a-z0-9][a-z0-9-]*$',
});
export type PresetKind = Static<typeof PresetKindSchema>;

export const GenerationPresetDataSchema = Type.Object(
  {
    maxContextTokens: Type.Integer({
      minimum: CONTEXT_TOKEN_MIN,
      maximum: CONTEXT_TOKEN_UNLOCKED_MAX,
    }),
    generationDefaults: GenerationDefaultsSchema,
  },
  { additionalProperties: false },
);
export type GenerationPresetData = Static<typeof GenerationPresetDataSchema>;

export const PresetSchema = Type.Object({
  id: IdSchema,
  kind: PresetKindSchema,
  name: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Preset = Static<typeof PresetSchema>;

export const PresetCreateSchema = Type.Object(
  {
    kind: PresetKindSchema,
    name: Type.String({ minLength: 1, maxLength: 500 }),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type PresetCreate = Static<typeof PresetCreateSchema>;

export const PresetUpdateSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type PresetUpdate = Static<typeof PresetUpdateSchema>;
