/**
 * Plugin SecretStore repository (ТЗ §54): per-plugin scoped secrets.
 *
 * Values are stored locally (local-first SQLite) but are write-only at the
 * API boundary: routes mask them and only the gated reveal endpoint returns a
 * plaintext. This repository is the single storage authority — secrets never
 * enter plugin state, namespaced backup/export sections, logs or diagnostics
 * (AGENTS.md §4, §11 — mirrors the provider secrets pattern).
 */
import type { SqliteConnection } from '../connection.js';

export type PluginSecretScope = 'user' | 'workspace' | 'chat' | 'installation';

export interface PluginSecretEntry {
  pluginId: string;
  scope: PluginSecretScope;
  key: string;
  value: string;
  createdAt: number;
  updatedAt: number;
}

interface SecretRow {
  plugin_id: string;
  scope: string;
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

const SELECT_COLUMNS = `SELECT plugin_id, scope, key, value, created_at, updated_at FROM plugin_secrets`;

function toEntry(row: SecretRow): PluginSecretEntry {
  return {
    pluginId: row.plugin_id,
    scope: row.scope as PluginSecretScope,
    key: row.key,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PluginSecretRepository {
  constructor(private readonly sqlite: SqliteConnection) {}

  /**
   * Create or overwrite a secret for the (plugin, scope, key) identity.
   * Returns the stored entry — callers must mask it before serializing.
   */
  upsert(
    pluginId: string,
    scope: PluginSecretScope,
    key: string,
    value: string,
  ): PluginSecretEntry {
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO plugin_secrets (plugin_id, scope, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, scope, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(pluginId, scope, key, value, now, now);
    const entry = this.get(pluginId, scope, key);
    if (!entry) throw new Error('plugin_secrets write did not return a row');
    return entry;
  }

  /** Full rows for a plugin (including values — mask before responding). */
  list(pluginId: string): PluginSecretEntry[] {
    return (
      this.sqlite
        .prepare(`${SELECT_COLUMNS} WHERE plugin_id = ? ORDER BY scope, key`)
        .all(pluginId) as SecretRow[]
    ).map(toEntry);
  }

  /** INTERNAL: full row including the plaintext value (reveal route). */
  get(pluginId: string, scope: PluginSecretScope, key: string): PluginSecretEntry | null {
    const row = this.sqlite
      .prepare(`${SELECT_COLUMNS} WHERE plugin_id = ? AND scope = ? AND key = ?`)
      .get(pluginId, scope, key) as SecretRow | undefined;
    return row ? toEntry(row) : null;
  }

  delete(pluginId: string, scope: PluginSecretScope, key: string): boolean {
    return (
      this.sqlite
        .prepare('DELETE FROM plugin_secrets WHERE plugin_id = ? AND scope = ? AND key = ?')
        .run(pluginId, scope, key).changes > 0
    );
  }
}
