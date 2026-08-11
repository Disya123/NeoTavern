/**
 * Connection Profiles — a saved, named bundle of connection settings layered
 * over provider configs (the classic SillyTavern "Connection Profiles" manager,
 * extended as a first-class NeoTavern entity).
 *
 * A profile carries *references* (provider config / secret / generation preset)
 * plus formatting overrides (prompt post-processing, additional parameters,
 * stop strings, start-reply-with). `exclude` lists bundle fields that must be
 * skipped when the profile is applied, mirroring SillyTavern's per-field exclude
 * checkboxes. Applying a profile writes the referenced/overridden values into
 * the live app settings and the target provider config (see
 * `/api/v2/connection-profiles/:id/apply`).
 *
 * Profiles never store secret values — only a `secretId` reference; the secret
 * stays write-only in {@link ./secrets.ts}.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';
import {
  CustomIncludeBodySchema,
  CustomExcludeBodySchema,
  CustomIncludeHeadersSchema,
} from './provider.js';
import { PromptPostProcessingModeSchema } from './settings.js';

/** Whether the profile targets a chat-completion or a text-completion backend. */
export const ConnectionProfileModeSchema = Type.Union([Type.Literal('chat'), Type.Literal('text')]);
export type ConnectionProfileMode = Static<typeof ConnectionProfileModeSchema>;

/**
 * Bundle fields that a profile may carry and that `exclude` can suppress on
 * apply. Kept as a const list so the UI can render one checkbox per field and
 * the server can validate `exclude` entries.
 */
export const ConnectionProfileFields = [
  'providerConfigId',
  'source',
  'baseUrl',
  'model',
  'secretId',
  'presetId',
  'promptPostProcessing',
  'includeBody',
  'excludeBody',
  'includeHeaders',
  'stopStrings',
  'startReplyWith',
] as const;
export const ConnectionProfileFieldSchema = Type.Union(
  ConnectionProfileFields.map((field) => Type.Literal(field)),
);
export type ConnectionProfileField = Static<typeof ConnectionProfileFieldSchema>;

/** Shared optional override body used by the full, create and update schemas. */
const ConnectionProfileOverrides = {
  /** Referenced provider config the profile activates on apply. */
  providerConfigId: Type.Optional(IdSchema),
  /** Source id snapshot (display + validation helper; not applied verbatim). */
  source: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  /** Base URL override applied to the referenced provider config. */
  baseUrl: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()])),
  /** Model id override applied to the referenced provider config. */
  model: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()])),
  /** Referenced secret (API key) to make active on the provider config. */
  secretId: Type.Optional(IdSchema),
  /** Generation preset to activate on apply. */
  presetId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  /** Prompt post-processing mode written into the provider config settings. */
  promptPostProcessing: Type.Optional(PromptPostProcessingModeSchema),
  /** Additional request-body keys merged on generation. */
  includeBody: Type.Optional(CustomIncludeBodySchema),
  /** Request-body keys removed on generation. */
  excludeBody: Type.Optional(CustomExcludeBodySchema),
  /** Additional request headers (forbidden headers are rejected on apply). */
  includeHeaders: Type.Optional(CustomIncludeHeadersSchema),
  /** Stop sequences written into the generation defaults. */
  stopStrings: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 64 })),
  /** Prefix the assistant reply is forced to start with. */
  startReplyWith: Type.Optional(Type.String({ maxLength: 2048 })),
};

export const ConnectionProfileSchema = Type.Object(
  {
    id: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    mode: ConnectionProfileModeSchema,
    ...ConnectionProfileOverrides,
    /** Bundle fields skipped when the profile is applied. */
    exclude: Type.Array(ConnectionProfileFieldSchema, { maxItems: 64 }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type ConnectionProfile = Static<typeof ConnectionProfileSchema>;

export const ConnectionProfileListSchema = Type.Object(
  { items: Type.Array(ConnectionProfileSchema) },
  { additionalProperties: false },
);
export type ConnectionProfileList = Static<typeof ConnectionProfileListSchema>;

/** Body for POST /api/v2/connection-profiles. */
export const ConnectionProfileCreateSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    mode: ConnectionProfileModeSchema,
    ...ConnectionProfileOverrides,
    exclude: Type.Optional(Type.Array(ConnectionProfileFieldSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);
export type ConnectionProfileCreate = Static<typeof ConnectionProfileCreateSchema>;

export const ConnectionProfileCreatedSchema = Type.Object(
  { id: IdSchema },
  { additionalProperties: false },
);
export type ConnectionProfileCreated = Static<typeof ConnectionProfileCreatedSchema>;

/** Body for PATCH /api/v2/connection-profiles/:id. */
export const ConnectionProfileUpdateSchema = Type.Partial(ConnectionProfileCreateSchema);
export type ConnectionProfileUpdate = Static<typeof ConnectionProfileUpdateSchema>;

/**
 * Result of POST /api/v2/connection-profiles/:id/apply — reports which live
 * settings the bundle actually touched (after `exclude` filtering), so the UI
 * can confirm what changed.
 */
export const ConnectionProfileApplyResultSchema = Type.Object(
  {
    activeProviderConfigId: Type.Union([IdSchema, Type.Null()]),
    activeGenerationPresetId: Type.Union([IdSchema, Type.Null()]),
    /** Bundle fields that were applied (post-exclude). */
    appliedFields: Type.Array(ConnectionProfileFieldSchema),
    /** Bundle fields skipped because they appear in `exclude`. */
    excludedFields: Type.Array(ConnectionProfileFieldSchema),
  },
  { additionalProperties: false },
);
export type ConnectionProfileApplyResult = Static<typeof ConnectionProfileApplyResultSchema>;
