/**
 * Backup routes: /api/v2/backups. Create/list online backups and restore.
 * Restore uses SQLite's online backup API so the live connection and existing
 * repositories remain usable. A safety backup of the current database is
 * always taken before a restore, and automatic safety backups are rotated
 * (ТЗ §10.4). Automatic pre-migration snapshots (taken by the migration
 * runner) are listed with kind "auto".
 *
 * Plugin namespaces (ТЗ §54 backup policy): every manual backup is
 * accompanied by an ADDITIVE, OPTIONAL `<id>.plugin-namespaces.json` sidecar
 * carrying the `pluginNamespaces` section — plugin state only, secrets NEVER.
 * The SQLite snapshot remains the primary artifact (it is self-sufficient);
 * the sidecar makes the namespace content explicit and machine-readable.
 * Restore applies the sidecar with a conflict-skip policy: rows whose
 * (plugin, scope, owner) identity already exists are kept — a backup never
 * clobbers existing state. The reader is unknown-section tolerant: only the
 * `pluginNamespaces` section is consumed, future sections are ignored.
 */
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { AckSchema, BackupListResponseSchema, BackupSchema, IdSchema } from '@neotavern/contracts';
import {
  PRE_MIGRATION_BACKUP_PREFIX,
  rotatePrefixedBackups,
  type PluginStateScope,
} from '@neotavern/db';
import { AppError, ErrorCodes } from '@neotavern/shared';
import type { AppContext, TypedApp } from '../types.js';

const PRE_RESTORE_PREFIX = 'pre-restore-';
/** Retention for automatic safety backups (ТЗ §10.4: «несколько последних»). */
const AUTO_BACKUP_RETENTION = 5;
/** Suffix of the additive plugin-namespaces sidecar next to a `.db` backup. */
const NAMESPACES_SIDECAR_SUFFIX = '.plugin-namespaces.json';
const STATE_SCOPES = new Set<PluginStateScope>(['user', 'workspace', 'chat', 'installation']);

interface NamespaceStateRow {
  scope: PluginStateScope;
  ownerId: string | null;
  schemaVersion: number;
  revision: number;
  data: Record<string, unknown>;
}

interface PluginNamespace {
  pluginId: string;
  state: NamespaceStateRow[];
}

/**
 * Build the `pluginNamespaces` section: per-plugin namespaced state only.
 * Secrets are never included (ТЗ §54 — they live in the SecretStore and are
 * write-only at every boundary).
 */
function buildPluginNamespaces(ctx: AppContext): PluginNamespace[] {
  const stateRepo = ctx.database.repos.pluginState;
  return ctx.database.repos.plugins.list().map((plugin) => ({
    pluginId: plugin.id,
    state: stateRepo.list(plugin.id).map((row) => ({
      scope: row.scope,
      ownerId: row.ownerId,
      schemaVersion: row.schemaVersion,
      revision: row.revision,
      data: row.data,
    })),
  }));
}

function sidecarPath(backupsDir: string, backupId: string): string {
  return join(backupsDir, `${backupId}${NAMESPACES_SIDECAR_SUFFIX}`);
}

/**
 * Unknown-section-tolerant reader for the sidecar container: the top level
 * may carry any additional sections in the future; only `pluginNamespaces`
 * is consumed and malformed entries are skipped individually.
 */
function readPluginNamespaces(value: unknown): PluginNamespace[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const section = (value as Record<string, unknown>)['pluginNamespaces'];
  if (!Array.isArray(section)) return [];
  const namespaces: PluginNamespace[] = [];
  for (const item of section) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record['pluginId'] !== 'string' || !Array.isArray(record['state'])) continue;
    const rows: NamespaceStateRow[] = [];
    for (const rawRow of record['state']) {
      if (typeof rawRow !== 'object' || rawRow === null || Array.isArray(rawRow)) continue;
      const row = rawRow as Record<string, unknown>;
      if (typeof row['scope'] !== 'string' || !STATE_SCOPES.has(row['scope'] as PluginStateScope)) {
        continue;
      }
      if (
        typeof row['ownerId'] !== 'string' &&
        row['ownerId'] !== null &&
        row['ownerId'] !== undefined
      ) {
        continue;
      }
      if (
        typeof row['schemaVersion'] !== 'number' ||
        !Number.isInteger(row['schemaVersion']) ||
        typeof row['revision'] !== 'number' ||
        !Number.isInteger(row['revision'])
      ) {
        continue;
      }
      if (typeof row['data'] !== 'object' || row['data'] === null || Array.isArray(row['data'])) {
        continue;
      }
      rows.push({
        scope: row['scope'] as PluginStateScope,
        ownerId: row['ownerId'] === undefined ? null : (row['ownerId'] as string | null),
        schemaVersion: row['schemaVersion'],
        revision: row['revision'],
        data: row['data'] as Record<string, unknown>,
      });
    }
    if (rows.length === 0) continue;
    namespaces.push({ pluginId: record['pluginId'], state: rows });
  }
  return namespaces;
}

/**
 * Write the namespaced state back after a full SQLite restore. The sidecar is
 * optional — a missing or malformed sidecar is tolerated (the snapshot alone
 * already restores state). Conflict policy: rows whose identity already
 * exists are kept, never clobbered (ТЗ §54).
 */
async function restorePluginNamespaces(ctx: AppContext, backupId: string): Promise<void> {
  const path = sidecarPath(ctx.paths.backups, backupId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return; // no sidecar: the SQLite snapshot covers state on its own
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    ctx.logger.warn(`plugin-namespaces sidecar ${path} is not valid JSON; skipped`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }
  const namespaces = readPluginNamespaces(parsed);
  if (namespaces.length === 0) return;
  const stateRepo = ctx.database.repos.pluginState;
  let restored = 0;
  for (const namespace of namespaces) {
    for (const row of namespace.state) {
      if (
        stateRepo.restore({
          pluginId: namespace.pluginId,
          scope: row.scope,
          ownerId: row.ownerId,
          schemaVersion: row.schemaVersion,
          revision: row.revision,
          data: row.data,
        })
      ) {
        restored += 1;
      }
    }
  }
  if (restored > 0) {
    ctx.logger.info(`restored ${restored} plugin state rows from ${path}`);
  }
}

export async function registerBackupRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  app.post('/api/v2/backups', { schema: { response: { 200: BackupSchema } } }, async () => {
    const id = `backup-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
    const dest = join(ctx.paths.backups, `${id}.db`);
    try {
      await ctx.database.backup(dest);
      const info = await stat(dest);
      // Additive/optional plugin-namespaces section (ТЗ §54): the SQLite
      // snapshot is the primary artifact, so a sidecar failure must not fail
      // the backup — it is logged and skipped.
      try {
        await writeFile(
          sidecarPath(ctx.paths.backups, id),
          JSON.stringify({
            format: 'neotavern-plugin-namespaces',
            formatVersion: 1,
            pluginNamespaces: buildPluginNamespaces(ctx),
          }),
          'utf8',
        );
      } catch (cause) {
        ctx.logger.warn(`plugin-namespaces sidecar write failed for ${id}`, {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      return { id, kind: 'manual' as const, createdAt: Date.now(), sizeBytes: info.size };
    } catch (cause) {
      throw new AppError({ code: ErrorCodes.BACKUP_FAILED, cause });
    }
  });

  app.get(
    '/api/v2/backups',
    { schema: { response: { 200: BackupListResponseSchema } } },
    async () => {
      const files = await readdir(ctx.paths.backups).catch((error: NodeJS.ErrnoException) => {
        // "Directory does not exist yet" is normal; any other failure (EACCES,
        // EIO, …) must not masquerade as "no backups".
        if (error?.code !== 'ENOENT') {
          ctx.logger.warn(`backup directory unreadable: ${error?.code ?? 'UNKNOWN'}`);
        }
        return [] as string[];
      });
      const items: Array<{
        id: string;
        kind: 'manual' | 'auto';
        createdAt: number;
        sizeBytes: number;
      }> = [];
      for (const file of files) {
        if (!file.endsWith('.db')) continue;
        const info = await stat(join(ctx.paths.backups, file));
        const auto =
          file.startsWith(PRE_RESTORE_PREFIX) || file.startsWith(PRE_MIGRATION_BACKUP_PREFIX);
        items.push({
          id: file.replace(/\.db$/, ''),
          kind: auto ? 'auto' : 'manual',
          createdAt: Math.round(info.mtimeMs),
          sizeBytes: info.size,
        });
      }
      items.sort((a, b) => b.createdAt - a.createdAt);
      return { items };
    },
  );

  // Delete a stored backup snapshot (ТЗ §10.4 backup management). Only files
  // inside the backups directory with the .db convention are removable; the
  // companion plugin-namespaces sidecar goes with it.
  app.delete(
    '/api/v2/backups/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: AckSchema },
      },
    },
    async (req) => {
      const id = req.params.id;
      if (id.includes('..') || id.includes('/') || id.includes('\\')) {
        throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { field: 'id' } });
      }
      await rm(join(ctx.paths.backups, `${id}.db`), { force: true });
      await rm(sidecarPath(ctx.paths.backups, id), { force: true });
      return { ok: true };
    },
  );

  app.post(
    '/api/v2/backups/:id/restore',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: {
          200: Type.Object({ restored: Type.Boolean(), restartRequired: Type.Boolean() }),
        },
      },
    },
    async (req) => {
      const id = req.params.id;
      // Reject path traversal (ZIP/restore safety, ТЗ §13).
      if (id.includes('..') || id.includes('/') || id.includes('\\')) {
        throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { field: 'id' } });
      }
      const source = join(ctx.paths.backups, `${id}.db`);
      const sourceInfo = await stat(source).catch(() => null);
      if (!sourceInfo) {
        throw new AppError({ code: ErrorCodes.RESTORE_FAILED, params: { backupId: id } });
      }
      // ТЗ §10.4: restore runs exclusively under global maintenance mode —
      // while it is held, the mutation gate rejects new product mutations and
      // no second restore can enter. The lock is released on every exit path.
      const releaseMaintenance = ctx.maintenance.acquire();
      try {
        // Safety backup of the current database before overwriting.
        const safety = join(
          ctx.paths.backups,
          `${PRE_RESTORE_PREFIX}${new Date().toISOString().replaceAll(/[:.]/g, '-')}.db`,
        );
        try {
          await ctx.database.backup(safety);
          rotatePrefixedBackups(ctx.paths.backups, PRE_RESTORE_PREFIX, AUTO_BACKUP_RETENTION);
          await ctx.database.restore(source);
          // Apply the additive plugin-namespaces section (conflict-skip).
          await restorePluginNamespaces(ctx, id);
          return { restored: true, restartRequired: false };
        } catch (cause) {
          throw new AppError({
            code: ErrorCodes.RESTORE_FAILED,
            params: { backupId: id },
            cause,
          });
        }
      } finally {
        releaseMaintenance();
      }
    },
  );
}
