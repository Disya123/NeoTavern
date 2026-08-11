/**
 * Provider secrets — multiple labelled API keys per provider connection.
 *
 * Mirrors the SillyTavern secrets manager behaviour: a provider may hold
 * several stored keys, exactly one of which is *active* and used for
 * generation. Secret **values are write-only**: they never appear in list or
 * state schemas. Only the dedicated `/reveal` endpoint returns a plaintext
 * value, and only when secrets exposure is explicitly enabled server-side
 * (`NEOTA_ALLOW_SECRETS_EXPOSURE`, default off) — the equivalent of SillyTavern's
 * `allowKeysExposure` gate (AGENTS.md §4, §11).
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';

/** Public projection of a stored secret — never contains the secret value. */
export const ProviderSecretSchema = Type.Object(
  {
    id: IdSchema,
    providerId: IdSchema,
    label: Type.Union([Type.String(), Type.Null()]),
    /** True for the key currently used for generation requests. */
    active: Type.Boolean(),
    /** Masked preview for display (e.g. "••••••••e895"); never the full value. */
    masked: Type.String(),
    createdAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type ProviderSecret = Static<typeof ProviderSecretSchema>;

export const ProviderSecretListSchema = Type.Object(
  { items: Type.Array(ProviderSecretSchema) },
  { additionalProperties: false },
);
export type ProviderSecretList = Static<typeof ProviderSecretListSchema>;

/** Body for POST /api/v2/providers/:id/secrets. `value` is write-only. */
export const ProviderSecretCreateSchema = Type.Object(
  {
    /** May be empty for keyless local endpoints; otherwise stored verbatim. */
    value: Type.String({ maxLength: 8192 }),
    label: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type ProviderSecretCreate = Static<typeof ProviderSecretCreateSchema>;

export const ProviderSecretCreatedSchema = Type.Object(
  { id: IdSchema },
  { additionalProperties: false },
);
export type ProviderSecretCreated = Static<typeof ProviderSecretCreatedSchema>;

/** Body for PATCH /api/v2/providers/:id/secrets/:secretId. */
export const ProviderSecretUpdateSchema = Type.Object(
  {
    label: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    /** Setting true activates this key and deactivates every sibling. */
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ProviderSecretUpdate = Static<typeof ProviderSecretUpdateSchema>;

/** Response for POST /api/v2/providers/:id/secrets/:secretId/reveal. */
export const ProviderSecretRevealSchema = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);
export type ProviderSecretReveal = Static<typeof ProviderSecretRevealSchema>;

/** Response for GET /api/v2/secrets/exposure. */
export const SecretsExposureSchema = Type.Object(
  { allowSecretsExposure: Type.Boolean() },
  { additionalProperties: false },
);
export type SecretsExposure = Static<typeof SecretsExposureSchema>;

/**
 * Mask a secret value for safe display: keep only the last few characters and
 * replace the remainder with bullets (matches SillyTavern `getMaskedValue`).
 */
export function maskSecretValue(value: string, visibleSuffix = 4): string {
  if (value.length === 0) return '';
  if (value.length <= visibleSuffix) return '•'.repeat(value.length);
  return `${'•'.repeat(Math.min(8, value.length - visibleSuffix))}${value.slice(-visibleSuffix)}`;
}
