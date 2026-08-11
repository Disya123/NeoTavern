/**
 * Installed-theme registry.
 *
 * Activation updates both the registry and `settings.themeId` in one SQLite
 * transaction so the API can never expose two active themes or a stale
 * settings pointer.
 */
import type { SqliteConnection } from '../connection.js';
import { parseJson, toJson } from '../json.js';

export interface ThemeRegistryEntry {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  manifest: Record<string, unknown>;
  installedAt: number;
}

interface ThemeRow {
  id: string;
  name: string;
  version: string;
  enabled: number;
  manifest: string;
  installed_at: number;
}

function toEntry(row: ThemeRow): ThemeRegistryEntry {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    enabled: row.enabled === 1,
    manifest: parseJson<Record<string, unknown>>(row.manifest, {}),
    installedAt: row.installed_at,
  };
}

export class ThemeRepository {
  constructor(private readonly sqlite: SqliteConnection) {}

  list(): ThemeRegistryEntry[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, name, version, enabled, manifest, installed_at
         FROM theme_registry
         ORDER BY name COLLATE NOCASE, id`,
      )
      .all() as ThemeRow[];
    return rows.map(toEntry);
  }

  getById(id: string): ThemeRegistryEntry | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, name, version, enabled, manifest, installed_at
         FROM theme_registry
         WHERE id = ?`,
      )
      .get(id) as ThemeRow | undefined;
    return row ? toEntry(row) : null;
  }

  install(input: {
    id: string;
    name: string;
    version: string;
    manifest: Record<string, unknown>;
  }): { theme: ThemeRegistryEntry; replaced: boolean } {
    const existing = this.getById(input.id);
    const installedAt = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO theme_registry (id, name, version, enabled, manifest, installed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           manifest = excluded.manifest,
           installed_at = excluded.installed_at`,
      )
      .run(
        input.id,
        input.name,
        input.version,
        existing?.enabled ? 1 : 0,
        toJson(input.manifest),
        installedAt,
      );
    const theme = this.getById(input.id);
    if (!theme) throw new Error('Theme registry write did not return a row');
    return { theme, replaced: existing !== null };
  }

  activate(id: string): ThemeRegistryEntry | null {
    const transaction = this.sqlite.transaction(() => {
      const exists = this.sqlite
        .prepare('SELECT 1 AS present FROM theme_registry WHERE id = ?')
        .get(id);
      if (!exists) return null;
      this.sqlite.prepare('UPDATE theme_registry SET enabled = 0 WHERE enabled = 1').run();
      this.sqlite.prepare('UPDATE theme_registry SET enabled = 1 WHERE id = ?').run(id);
      this.writeActiveTheme(id);
      return this.getById(id);
    });
    return transaction();
  }

  resetActive(): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare('UPDATE theme_registry SET enabled = 0 WHERE enabled = 1').run();
      this.writeActiveTheme(null);
    })();
  }

  delete(id: string): { deleted: boolean; wasActive: boolean } {
    const transaction = this.sqlite.transaction(() => {
      const existing = this.getById(id);
      if (!existing) return { deleted: false, wasActive: false };
      this.sqlite.prepare('DELETE FROM theme_registry WHERE id = ?').run(id);
      if (existing.enabled) this.writeActiveTheme(null);
      return { deleted: true, wasActive: existing.enabled };
    });
    return transaction();
  }

  private writeActiveTheme(id: string | null): void {
    this.sqlite
      .prepare(
        `INSERT INTO settings (key, value)
         VALUES ('themeId', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(toJson(id));
  }
}
