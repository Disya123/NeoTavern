/**
 * Durable per-artifact import identities.
 *
 * A full SillyTavern archive can contain thousands of independently imported
 * objects. Tracking each source artifact makes retries idempotent even after a
 * process interruption halfway through an archive. The table is additive and
 * does not rewrite existing user data.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS import_artifacts (
  source_kind TEXT NOT NULL,
  source_key  TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  status      TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (source_kind, source_key)
) STRICT;
CREATE INDEX IF NOT EXISTS import_artifacts_target_idx
  ON import_artifacts(target_kind, target_id);
CREATE INDEX IF NOT EXISTS import_artifacts_hash_idx
  ON import_artifacts(source_hash);
`;

export const migration: Migration = {
  version: 2,
  name: '0002_import_artifacts',
  up,
};
