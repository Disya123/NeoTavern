/**
 * Plugin SecretStore repository (ТЗ §54, §SEC-01): per-plugin scoped secrets.
 *
 * Since migration 0024 the database never holds plaintext: the `value_ref`
 * column stores an opaque SecretStore reference and the legacy `value` column
 * is the import source for pre-migration rows. Values are write-only at the
 * API boundary: routes mask them and only the gated reveal endpoint returns a
 * plaintext (resolved through the SecretStore by the server layer). Secrets
 * never enter plugin state, namespaced backup/export sections, logs or
 * diagnostics.
 */
import type { SqliteConnection } from '../connection.js';

export type PluginSecretScope = 'user' | 'workspace' | 'chat' | 'installation';

export interface PluginSecretEntry {
  pluginId: string;
  scope: PluginSecretScope;
  key: string;
  /** Opaque SecretStore reference (post-migration rows). */
  valueRef: string | null;
  /** Legacy plaintext import source — cleared by the bootstrap importer. */
  value: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SecretRow {
  plugin_id: string;
  scope: string;
  key: string;
  value: string | null;
  value_ref: string | null;
  created_at: number;
  updated_at: number;
}

const SELECT_COLUMNS = `SELECT plugin_id, scope, key, value, value_ref, created_at, updated_at FROM plugin_secrets`;

function toEntry(row: SecretRow): PluginSecretEntry {
  return {
    pluginId: row.plugin_id,
    scope: row.scope as PluginSecretScope,
    key: row.key,
    value: row.value,
    valueRef: row.value_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PluginSecretRepository {
  constructor(private readonly sqlite: SqliteConnection) {}

  /**
   * Create or overwrite a secret for the (plugin, scope, key) identity. The
   * value argument is an opaque SecretStore reference — never plaintext.
   * Returns the stored entry — callers must mask it before serializing.
   */
  upsert(
    pluginId: string,
    scope: PluginSecretScope,
    key: string,
    valueRef: string,
  ): PluginSecretEntry {
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO plugin_secrets (plugin_id, scope, key, value, value_ref, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?, ?)
         ON CONFLICT(plugin_id, scope, key) DO UPDATE SET
           value = '',
           value_ref = excluded.value_ref,
           updated_at = excluded.updated_at`,
      )
      .run(pluginId, scope, key, valueRef, now, now);
    const entry = this.get(pluginId, scope, key);
    if (!entry) throw new Error('plugin_secrets write did not return a row');
    return entry;
  }

  /** Full rows for a plugin (including refs — mask before responding). */
  list(pluginId: string): PluginSecretEntry[] {
    return (
      this.sqlite
        .prepare(`${SELECT_COLUMNS} WHERE plugin_id = ? ORDER BY scope, key`)
        .all(pluginId) as SecretRow[]
    ).map(toEntry);
  }

  /** INTERNAL: full row including the opaque reference (reveal route). */
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

  /**
   * Pre-migration rows still holding plaintext (`value` set, `value_ref` NULL).
   * The bootstrap importer moves them into the SecretStore and rewrites them
   * as references (see apps/server/src/lib/secretStore.ts).
   */
  listUnmigrated(): Array<{
    pluginId: string;
    scope: PluginSecretScope;
    key: string;
    value: string;
  }> {
    return (
      this.sqlite
        .prepare(`${SELECT_COLUMNS} WHERE value IS NOT NULL AND value_ref IS NULL`)
        .all() as SecretRow[]
    ).map((row) => ({
      pluginId: row.plugin_id,
      scope: row.scope as PluginSecretScope,
      key: row.key,
      value: row.value as string,
    }));
  }

  /** Rewrite an imported row: keep only the opaque reference. */
  markMigrated(pluginId: string, scope: PluginSecretScope, key: string, valueRef: string): void {
    this.sqlite
      .prepare(
        "UPDATE plugin_secrets SET value = '', value_ref = ? WHERE plugin_id = ? AND scope = ? AND key = ?",
      )
      .run(valueRef, pluginId, scope, key);
  }
}
