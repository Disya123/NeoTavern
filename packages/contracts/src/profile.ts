/**
 * Profile schemas (ТЗ §10.2, §10.4). The local app is single-profile today;
 * the registry exists so identities are stable and portable profile archives
 * can be exported/restored.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';

export const ProfileSchema = Type.Object({
  id: IdSchema,
  name: Type.String(),
  createdAt: TimestampSchema,
});
export type Profile = Static<typeof ProfileSchema>;

export const ProfileUpdateSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type ProfileUpdate = Static<typeof ProfileUpdateSchema>;

export const ProfileListResponseSchema = Type.Object({
  items: Type.Array(ProfileSchema),
  /** The active profile (first created — single-profile builds). */
  currentId: IdSchema,
});
export type ProfileListResponse = Static<typeof ProfileListResponseSchema>;

/**
 * Binary body returned by `GET /api/v2/profiles/export`.
 * `contentEncoding` documents the streamed ZIP payload for schema consumers.
 */
export const ProfileExportResponseSchema = Type.Unsafe<NodeJS.ReadableStream>({
  type: 'string',
  contentEncoding: 'binary',
  contentMediaType: 'application/zip',
});
export type ProfileExportResponse = Static<typeof ProfileExportResponseSchema>;
