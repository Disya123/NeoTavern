/**
 * Plugin user-state and capability grants (Plugin SDK rev4 §B, §5 data model).
 *
 * The registry describes installation and metadata; user state has a
 * different lifecycle (scope, quotas, migration, ownership) and therefore
 * lives in its own table. Grants are stored per plugin with a CAS revision
 * distinct from the plugin data `schema_version`.
 *
 * Additive DDL only; rollback is restoring the pre-migration backup the
 * runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS plugin_state (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'workspace', 'chat', 'installation')),
  owner_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_state_owner
  ON plugin_state(plugin_id, scope, COALESCE(owner_id, ''));
CREATE INDEX IF NOT EXISTS idx_plugin_state_plugin ON plugin_state(plugin_id);

CREATE TABLE IF NOT EXISTS plugin_capability_grants (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_grant_name
  ON plugin_capability_grants(plugin_id, name);
CREATE INDEX IF NOT EXISTS idx_plugin_grant_plugin ON plugin_capability_grants(plugin_id);
`;

export const migration: Migration = {
  version: 16,
  name: '0016_plugin_state_and_grants',
  up,
};
