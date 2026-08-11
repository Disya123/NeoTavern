/**
 * Plugin OAuth connection persistence (rev4 §K5, api.auth).
 *
 * Security contract: the access/refresh token JSON lives only in this
 * repository, server-side. The sandbox receives metadata only, and
 * authenticated outbound traffic is signed by the server through the
 * `network.fetch` proxy. The OAuth `state` is one-shot: it is cleared on a
 * successful callback, so a replayed callback fails with `STATE_EXPIRED`.
 */
import { uuidv7 } from '@neotavern/shared';
import type { SqliteConnection } from '../connection.js';
import { toJson } from '../json.js';

export type AuthConnectionStatus = 'pending' | 'connected' | 'expired' | 'revoked';

export interface AuthConnectionEntry {
  id: string;
  pluginId: string;
  serviceId: string;
  serviceName: string;
  scopes: string[];
  status: AuthConnectionStatus;
  /** Opaque server-side token payload; never returned to the sandbox. */
  token: unknown;
  state: string;
  codeVerifier: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredTokenPayload {
  accessToken: string;
  tokenType: string;
  /** Millisecond epoch; null when the token has no expiry. */
  expiresAt: number | null;
  refreshToken?: string;
}

interface ConnectionRow {
  id: string;
  plugin_id: string;
  service_id: string;
  service_name: string;
  scopes_json: string;
  status: string;
  token_json: string | null;
  state: string;
  code_verifier: string;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `id, plugin_id, service_id, service_name, scopes_json, status,
                 token_json, state, code_verifier, created_at, updated_at`;

function toEntry(row: ConnectionRow): AuthConnectionEntry {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    scopes: JSON.parse(row.scopes_json) as string[],
    status: row.status as AuthConnectionStatus,
    token: row.token_json === null ? null : (JSON.parse(row.token_json) as unknown),
    state: row.state,
    codeVerifier: row.code_verifier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PluginAuthRepository {
  constructor(private readonly sqlite: SqliteConnection) {}

  list(pluginId: string): AuthConnectionEntry[] {
    return (
      this.sqlite
        .prepare(
          `SELECT ${COLUMNS} FROM plugin_auth_connections WHERE plugin_id = ? ORDER BY created_at`,
        )
        .all(pluginId) as ConnectionRow[]
    ).map(toEntry);
  }

  getById(pluginId: string, id: string): AuthConnectionEntry | null {
    const row = this.sqlite
      .prepare(`SELECT ${COLUMNS} FROM plugin_auth_connections WHERE plugin_id = ? AND id = ?`)
      .get(pluginId, id) as ConnectionRow | undefined;
    return row ? toEntry(row) : null;
  }

  /** A connection of the plugin that is still usable (not expired/revoked). */
  getActiveByService(pluginId: string, serviceId: string): AuthConnectionEntry | null {
    const row = this.sqlite
      .prepare(
        `SELECT ${COLUMNS} FROM plugin_auth_connections
         WHERE plugin_id = ? AND service_id = ?
           AND status IN ('pending', 'connected')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(pluginId, serviceId) as ConnectionRow | undefined;
    return row ? toEntry(row) : null;
  }

  /** Lookup for the OAuth callback; the state is one-shot and cleared on success. */
  getByState(state: string): AuthConnectionEntry | null {
    const row = this.sqlite
      .prepare(`SELECT ${COLUMNS} FROM plugin_auth_connections WHERE state = ?`)
      .get(state) as ConnectionRow | undefined;
    return row ? toEntry(row) : null;
  }

  createPending(input: {
    pluginId: string;
    serviceId: string;
    serviceName: string;
    scopes: string[];
    state: string;
    codeVerifier: string;
  }): AuthConnectionEntry {
    const now = Date.now();
    const id = uuidv7();
    this.sqlite
      .prepare(
        `INSERT INTO plugin_auth_connections (
           id, plugin_id, service_id, service_name, scopes_json, status,
           token_json, state, code_verifier, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.pluginId,
        input.serviceId,
        input.serviceName,
        toJson(input.scopes),
        input.state,
        input.codeVerifier,
        now,
        now,
      );
    const entry = this.getById(input.pluginId, id);
    if (!entry) throw new Error('auth connection write did not return a row');
    return entry;
  }

  markConnected(id: string, token: StoredTokenPayload): AuthConnectionEntry {
    this.sqlite
      .prepare(
        `UPDATE plugin_auth_connections
         SET status = 'connected', token_json = ?, state = '', updated_at = ?
         WHERE id = ?`,
      )
      .run(toJson(token), Date.now(), id);
    const row = this.sqlite
      .prepare('SELECT plugin_id FROM plugin_auth_connections WHERE id = ?')
      .get(id) as { plugin_id: string } | undefined;
    if (!row) throw new Error('auth connection update did not return a row');
    const entry = this.getById(row.plugin_id, id);
    if (!entry) throw new Error('auth connection update did not return a row');
    return entry;
  }

  markExpired(id: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE plugin_auth_connections
           SET status = 'expired', token_json = NULL, updated_at = ?
           WHERE id = ? AND status = 'connected'`,
        )
        .run(now, id).changes > 0
    );
  }

  revoke(id: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE plugin_auth_connections
           SET status = 'revoked', token_json = NULL, state = '', updated_at = ?
           WHERE id = ?`,
        )
        .run(now, id).changes > 0
    );
  }

  deleteAll(pluginId: string): number {
    return this.sqlite
      .prepare('DELETE FROM plugin_auth_connections WHERE plugin_id = ?')
      .run(pluginId).changes;
  }
}
