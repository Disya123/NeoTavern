/**
 * Plugin OAuth connections (Plugin SDK rev4 §K5, api.auth).
 *
 * Tokens live ONLY in this table (server-side) and never leave the server:
 * the sandbox sees metadata, and authenticated traffic goes through the
 * server-side network proxy (`connectionId` → Authorization header). The
 * one-shot `state` and PKCE `code_verifier` are stored per connection so the
 * callback cannot be replayed and the code exchange happens server-side.
 *
 * Additive DDL only; rollback is restoring the pre-migration backup the
 * runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS plugin_auth_connections (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'expired', 'revoked')),
  token_json TEXT,
  state TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_plugin_auth_plugin
  ON plugin_auth_connections(plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_auth_state
  ON plugin_auth_connections(state);
`;

export const migration: Migration = {
  version: 17,
  name: '0017_plugin_auth_connections',
  up,
};
