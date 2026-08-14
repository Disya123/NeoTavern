/**
 * Migration 0024: opaque secret references (ТЗ §SEC-01).
 *
 * Secret values must not live in the main database — the DB stores an opaque
 * reference and the SecretStore owns the value. Both secret tables gain a
 * `value_ref` column; new writes go to `value_ref` with `value` left NULL.
 * The legacy `value` column is retained as the import source: on first app
 * bootstrap with an unlocked store, rows that still hold plaintext
 * (`value NOT NULL AND value_ref IS NULL`) are moved into the SecretStore and
 * rewritten as references (apps/server/src/lib/secretStore.ts). Rollback for
 * this additive migration is the pre-migration backup.
 */
import type { Migration } from './types.js';

export const migration: Migration = {
  version: 24,
  name: '0024_secret_value_refs',
  up: `
    ALTER TABLE provider_secrets ADD COLUMN value_ref TEXT;
    ALTER TABLE plugin_secrets ADD COLUMN value_ref TEXT;
    CREATE INDEX IF NOT EXISTS provider_secrets_ref_idx
      ON provider_secrets(provider_id) WHERE value_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS plugin_secrets_ref_idx
      ON plugin_secrets(plugin_id, scope, key) WHERE value_ref IS NOT NULL;
  `,
};
