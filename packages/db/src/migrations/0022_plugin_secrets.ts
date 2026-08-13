/**
 * Plugin SecretStore (ТЗ §54: "Plugin secrets хранятся только через scoped
 * SecretStore API и никогда не попадают в namespaced backup/export state").
 *
 * Values are stored locally (local-first SQLite) but are write-only at the
 * API boundary: list responses mask values, the plaintext is returned only by
 * the gated reveal route (NEOTA_ALLOW_SECRETS_EXPOSURE, default off — mirrors
 * the provider secrets pattern), and secrets never enter plugin state,
 * namespaced backup/export sections or diagnostics. Rows cascade with plugin
 * deletion (ТЗ §54 deletion policy).
 *
 * Additive DDL only; rollback is restoring the pre-migration backup the
 * runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS plugin_secrets (
  plugin_id TEXT NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'workspace', 'chat', 'installation')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, scope, key)
) STRICT;
`;

export const migration: Migration = {
  version: 22,
  name: '0022_plugin_secrets',
  up,
};
