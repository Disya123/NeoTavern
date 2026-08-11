/**
 * Move provider API keys into a dedicated multi-secret table.
 *
 * Each provider may now hold several labelled keys with exactly one active.
 * Existing single-key configs are migrated: a non-empty legacy `api_key`
 * becomes the provider's active secret (label "migrated") and the column is
 * nulled, so runtime reads come from `provider_secrets`. No key material is
 * lost; the runner snapshots the database before applying (ТЗ §10.4).
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS provider_secrets (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  label       TEXT,
  value       TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS provider_secrets_provider_idx
  ON provider_secrets(provider_id);

-- Migrate the legacy single-key column into one active secret per provider.
INSERT INTO provider_secrets (id, provider_id, label, value, active, created_at)
SELECT
  lower(hex(randomblob(16))),
  id,
  'migrated',
  api_key,
  1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM provider_configs
WHERE api_key IS NOT NULL AND api_key != '';

UPDATE provider_configs
SET api_key = NULL
WHERE api_key IS NOT NULL AND api_key != '';
`;

export const migration: Migration = {
  version: 9,
  name: '0009_provider_secrets',
  up,
};
