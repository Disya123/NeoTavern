/** Installed-plugin registry and explicit permission-consent state. */
import type { PluginDependencyRecord, PluginRuntimeStatus, PluginSource } from '@neotavern/contracts';
import type { SqliteConnection } from '../connection.js';
import { parseJson, toJson } from '../json.js';

export interface PluginRegistryEntry {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  manifest: Record<string, unknown>;
  requestedPermissions: string[];
  grantedPermissions: string[];
  installedAt: number;
  updatedAt: number;
  lastErrorCode: string | null;
  /** Install source descriptor, null for rows created before source tracking. */
  source: PluginSource | null;
  /** npm dependencies installed alongside the package, null when none. */
  dependencies: PluginDependencyRecord[] | null;
}

interface PluginRow {
  id: string;
  name: string;
  version: string;
  enabled: number;
  manifest: string;
  permissions: string;
  granted_permissions: string;
  installed_at: number;
  updated_at: number;
  last_error_code: string | null;
  source: string | null;
  dependencies: string | null;
}

const SELECT_COLUMNS = `SELECT id, name, version, enabled, manifest, permissions,
                granted_permissions, installed_at, updated_at, last_error_code,
                source, dependencies`;

function toEntry(row: PluginRow): PluginRegistryEntry {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    enabled: row.enabled === 1,
    manifest: parseJson<Record<string, unknown>>(row.manifest, {}),
    requestedPermissions: parseStringArray(row.permissions),
    grantedPermissions: parseStringArray(row.granted_permissions),
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    lastErrorCode: row.last_error_code,
    source: parseJson<PluginSource | null>(row.source, null),
    dependencies: parseDependencyRecords(row.dependencies),
  };
}

function parseDependencyRecords(json: string | null): PluginDependencyRecord[] | null {
  if (json === null) return null;
  const value = parseJson<unknown>(json, null);
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is PluginDependencyRecord => {
    if (typeof item !== 'object' || item === null) return false;
    const record = item as Record<string, unknown>;
    return typeof record['name'] === 'string' && typeof record['version'] === 'string';
  });
}

function parseStringArray(json: string): string[] {
  const value = parseJson<unknown>(json, []);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function pluginStatus(entry: PluginRegistryEntry): PluginRuntimeStatus {
  if (entry.enabled) return 'active';
  if (entry.lastErrorCode) return 'error';
  const granted = new Set(entry.grantedPermissions);
  return entry.requestedPermissions.some((permission) => !granted.has(permission))
    ? 'needs-consent'
    : 'disabled';
}

export class PluginRepository {
  constructor(private readonly sqlite: SqliteConnection) {}

  list(): PluginRegistryEntry[] {
    return (
      this.sqlite
        .prepare(
          `${SELECT_COLUMNS}
           FROM plugin_registry
           ORDER BY name COLLATE NOCASE, id`,
        )
        .all() as PluginRow[]
    ).map(toEntry);
  }

  getById(id: string): PluginRegistryEntry | null {
    const row = this.sqlite
      .prepare(
        `${SELECT_COLUMNS}
         FROM plugin_registry
         WHERE id = ?`,
      )
      .get(id) as PluginRow | undefined;
    return row ? toEntry(row) : null;
  }

  install(input: {
    id: string;
    name: string;
    version: string;
    manifest: Record<string, unknown>;
    requestedPermissions: string[];
    source?: PluginSource;
    dependencies?: PluginDependencyRecord[];
  }): { plugin: PluginRegistryEntry; replaced: boolean; addedPermissions: string[] } {
    const existing = this.getById(input.id);
    const granted = new Set(existing?.grantedPermissions ?? []);
    const requested = [...new Set(input.requestedPermissions)].sort();
    const keptGrants = requested.filter((permission) => granted.has(permission));
    const addedPermissions = requested.filter((permission) => !granted.has(permission));
    const now = Date.now();
    const installedAt = existing?.installedAt ?? now;
    const keepEnabled = existing?.enabled === true && addedPermissions.length === 0;

    this.sqlite
      .prepare(
        `INSERT INTO plugin_registry (
           id, name, version, enabled, manifest, permissions,
           granted_permissions, installed_at, updated_at, last_error_code,
           source, dependencies
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           enabled = excluded.enabled,
           manifest = excluded.manifest,
           permissions = excluded.permissions,
           granted_permissions = excluded.granted_permissions,
           updated_at = excluded.updated_at,
           last_error_code = NULL,
           source = excluded.source,
           dependencies = excluded.dependencies`,
      )
      .run(
        input.id,
        input.name,
        input.version,
        keepEnabled ? 1 : 0,
        toJson(input.manifest),
        toJson(requested),
        toJson(keptGrants),
        installedAt,
        now,
        input.source ? toJson(input.source) : null,
        input.dependencies && input.dependencies.length > 0 ? toJson(input.dependencies) : null,
      );
    const plugin = this.getById(input.id);
    if (!plugin) throw new Error('Plugin registry write did not return a row');
    return { plugin, replaced: existing !== null, addedPermissions };
  }

  grantAndEnable(id: string, permissions: string[]): PluginRegistryEntry | null {
    this.sqlite
      .prepare(
        `UPDATE plugin_registry
         SET granted_permissions = ?, enabled = 1, updated_at = ?, last_error_code = NULL
         WHERE id = ?`,
      )
      .run(toJson([...new Set(permissions)].sort()), Date.now(), id);
    return this.getById(id);
  }

  disable(id: string): PluginRegistryEntry | null {
    this.sqlite
      .prepare(
        `UPDATE plugin_registry
         SET enabled = 0, updated_at = ?, last_error_code = NULL
         WHERE id = ?`,
      )
      .run(Date.now(), id);
    return this.getById(id);
  }

  markError(id: string, code: string): PluginRegistryEntry | null {
    this.sqlite
      .prepare(
        `UPDATE plugin_registry
         SET enabled = 0, updated_at = ?, last_error_code = ?
         WHERE id = ?`,
      )
      .run(Date.now(), code, id);
    return this.getById(id);
  }

  delete(id: string): boolean {
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM plugin_storage WHERE plugin_id = ?').run(id);
      this.sqlite.prepare('DELETE FROM plugin_settings WHERE plugin_id = ?').run(id);
      return this.sqlite.prepare('DELETE FROM plugin_registry WHERE id = ?').run(id).changes > 0;
    });
    return transaction();
  }
}
