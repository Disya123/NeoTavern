/**
 * Plugin user-state and capability-grant persistence (rev4 §B, §5).
 *
 * The registry describes installation metadata; these tables hold the
 * user-owned state and the grants issued by the capability broker. Scope
 * descriptors are stored as JSON text — validation and satisfaction checks
 * live in the broker layer above, not here.
 */
import { uuidv7 } from '@neotavern/shared';
import type { SqliteConnection } from '../connection.js';
import { parseJson, toJson } from '../json.js';

export type PluginStateScope = 'user' | 'workspace' | 'chat' | 'installation';

export interface PluginStateEntry {
  id: string;
  pluginId: string;
  scope: PluginStateScope;
  ownerId: string | null;
  schemaVersion: number;
  revision: number;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CapabilityGrantEntry {
  id: string;
  pluginId: string;
  name: string;
  /** Parsed scope descriptor (CapabilityScope JSON). */
  scope: Record<string, unknown>;
  revision: number;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface StateRow {
  id: string;
  plugin_id: string;
  scope: string;
  owner_id: string | null;
  schema_version: number;
  revision: number;
  data: string;
  created_at: number;
  updated_at: number;
}

interface GrantRow {
  id: string;
  plugin_id: string;
  name: string;
  scope: string;
  revision: number;
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

function toStateEntry(row: StateRow): PluginStateEntry {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    scope: row.scope as PluginStateScope,
    ownerId: row.owner_id,
    schemaVersion: row.schema_version,
    revision: row.revision,
    data: parseJson<Record<string, unknown>>(row.data, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGrantEntry(row: GrantRow): CapabilityGrantEntry {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    name: row.name,
    scope: parseJson<Record<string, unknown>>(row.scope, {}),
    revision: row.revision,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/** CAS-guarded plugin user state (rev4 §5: revision ≠ schemaVersion). */
export class PluginStateRepository {
  constructor(private readonly sqlite: SqliteConnection) {}

  get(pluginId: string, scope: PluginStateScope, ownerId: string | null): PluginStateEntry | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, plugin_id, scope, owner_id, schema_version, revision, data, created_at, updated_at
         FROM plugin_state
         WHERE plugin_id = ? AND scope = ? AND COALESCE(owner_id, '') = ?`,
      )
      .get(pluginId, scope, ownerId ?? '') as StateRow | undefined;
    return row ? toStateEntry(row) : null;
  }

  list(pluginId: string): PluginStateEntry[] {
    return (
      this.sqlite
        .prepare(
          `SELECT id, plugin_id, scope, owner_id, schema_version, revision, data, created_at, updated_at
           FROM plugin_state
           WHERE plugin_id = ?
           ORDER BY scope, COALESCE(owner_id, '')`,
        )
        .all(pluginId) as StateRow[]
    ).map(toStateEntry);
  }

  /**
   * Create or update state. `expectedRevision` enforces compare-and-set on
   * existing rows; omit it to accept any current revision.
   */
  set(input: {
    pluginId: string;
    scope: PluginStateScope;
    ownerId?: string | null;
    data: Record<string, unknown>;
    expectedRevision?: number;
  }): { ok: true; entry: PluginStateEntry } | { ok: false; current: PluginStateEntry | null } {
    const existing = this.get(input.pluginId, input.scope, input.ownerId ?? null);
    if (
      existing &&
      input.expectedRevision !== undefined &&
      existing.revision !== input.expectedRevision
    ) {
      return { ok: false, current: existing };
    }
    const now = Date.now();
    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE plugin_state
           SET data = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(toJson(input.data), now, existing.id);
    } else {
      this.sqlite
        .prepare(
          `INSERT INTO plugin_state (
             id, plugin_id, scope, owner_id, schema_version, revision, data, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`,
        )
        .run(
          uuidv7(),
          input.pluginId,
          input.scope,
          input.ownerId ?? null,
          toJson(input.data),
          now,
          now,
        );
    }
    const entry = this.get(input.pluginId, input.scope, input.ownerId ?? null);
    if (!entry) throw new Error('plugin_state write did not return a row');
    return { ok: true, entry };
  }

  delete(pluginId: string, scope: PluginStateScope, ownerId: string | null): boolean {
    return (
      this.sqlite
        .prepare(
          `DELETE FROM plugin_state
           WHERE plugin_id = ? AND scope = ? AND COALESCE(owner_id, '') = ?`,
        )
        .run(pluginId, scope, ownerId ?? '').changes > 0
    );
  }

  deleteAll(pluginId: string): number {
    return this.sqlite.prepare('DELETE FROM plugin_state WHERE plugin_id = ?').run(pluginId)
      .changes;
  }

  /**
   * Restore a backed-up state row (ТЗ §54 backup policy). Conflict policy:
   * a row with the same (plugin, scope, owner) identity is KEPT — the backup
   * never clobbers an existing row. Returns whether the row was inserted.
   * The original `schemaVersion`/`revision` are preserved so CAS continuity
   * survives a restore.
   */
  restore(input: {
    pluginId: string;
    scope: PluginStateScope;
    ownerId: string | null;
    schemaVersion: number;
    revision: number;
    data: Record<string, unknown>;
  }): boolean {
    const existing = this.get(input.pluginId, input.scope, input.ownerId ?? null);
    if (existing) return false;
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO plugin_state (
           id, plugin_id, scope, owner_id, schema_version, revision, data, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv7(),
        input.pluginId,
        input.scope,
        input.ownerId ?? null,
        input.schemaVersion,
        input.revision,
        toJson(input.data),
        now,
        now,
      );
    return true;
  }
}

/** Capability grants issued by the broker (rev4 §B2). */
export class CapabilityGrantRepository {
  constructor(private readonly sqlite: SqliteConnection) {}

  get(pluginId: string, name: string): CapabilityGrantEntry | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, plugin_id, name, scope, revision, granted_at, expires_at, revoked_at
         FROM plugin_capability_grants
         WHERE plugin_id = ? AND name = ?`,
      )
      .get(pluginId, name) as GrantRow | undefined;
    return row ? toGrantEntry(row) : null;
  }

  /** Active (non-revoked, non-expired) grants for a plugin. */
  listActive(pluginId: string, now: number): CapabilityGrantEntry[] {
    return (
      this.sqlite
        .prepare(
          `SELECT id, plugin_id, name, scope, revision, granted_at, expires_at, revoked_at
           FROM plugin_capability_grants
           WHERE plugin_id = ? AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY name`,
        )
        .all(pluginId, now) as GrantRow[]
    ).map(toGrantEntry);
  }

  /** Issue or re-issue a grant; re-granting bumps the revision. */
  grant(input: {
    pluginId: string;
    name: string;
    scope: Record<string, unknown>;
    expiresAt?: number | null;
  }): CapabilityGrantEntry {
    const now = Date.now();
    const existing = this.get(input.pluginId, input.name);
    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE plugin_capability_grants
           SET scope = ?, revision = revision + 1, granted_at = ?, expires_at = ?, revoked_at = NULL
           WHERE id = ?`,
        )
        .run(toJson(input.scope), now, input.expiresAt ?? null, existing.id);
    } else {
      this.sqlite
        .prepare(
          `INSERT INTO plugin_capability_grants (
             id, plugin_id, name, scope, revision, granted_at, expires_at, revoked_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL)`,
        )
        .run(
          uuidv7(),
          input.pluginId,
          input.name,
          toJson(input.scope),
          now,
          input.expiresAt ?? null,
        );
    }
    const entry = this.get(input.pluginId, input.name);
    if (!entry) throw new Error('capability grant write did not return a row');
    return entry;
  }

  revoke(pluginId: string, name: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE plugin_capability_grants
           SET revoked_at = ?
           WHERE plugin_id = ? AND name = ? AND revoked_at IS NULL`,
        )
        .run(now, pluginId, name).changes > 0
    );
  }

  revokeAll(pluginId: string, now: number): number {
    return this.sqlite
      .prepare(
        `UPDATE plugin_capability_grants
           SET revoked_at = ?
           WHERE plugin_id = ? AND revoked_at IS NULL`,
      )
      .run(now, pluginId).changes;
  }
}
