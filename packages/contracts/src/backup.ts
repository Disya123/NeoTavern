/**
 * Backup contracts (/api/v2/backups).
 *
 * Single source of truth for the backup wire format (ADR-0004): the server
 * route schemas and the web UI both import from here. Previously the schema
 * lived in the server route plugin and the client redeclared a subset by
 * hand — the `kind` field had already drifted out of the UI type (ARCH-11).
 */
import { Type, type Static } from '@sinclair/typebox';

/** `manual` — user-initiated; `auto` — automatic pre-migration/pre-restore snapshots. */
export const BackupKinds = ['manual', 'auto'] as const;

export const BackupSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  kind: Type.Union([Type.Literal('manual'), Type.Literal('auto')]),
  createdAt: Type.Integer(),
  sizeBytes: Type.Integer({ minimum: 0 }),
});
export type Backup = Static<typeof BackupSchema>;
export type BackupKind = Static<typeof BackupSchema>['kind'];

export const BackupListResponseSchema = Type.Object({
  items: Type.Array(BackupSchema),
});
export type BackupListResponse = Static<typeof BackupListResponseSchema>;
