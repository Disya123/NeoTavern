/**
 * Backup routes: /api/v2/backups. Create/list online backups and restore.
 * Restore uses SQLite's online backup API so the live connection and existing
 * repositories remain usable. A safety backup of the current database is
 * always taken before a restore, and automatic safety backups are rotated
 * (ТЗ §10.4). Automatic pre-migration snapshots (taken by the migration
 * runner) are listed with kind "auto".
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { AckSchema, BackupListResponseSchema, BackupSchema, IdSchema } from '@neotavern/contracts';
import { PRE_MIGRATION_BACKUP_PREFIX, rotatePrefixedBackups } from '@neotavern/db';
import { AppError, ErrorCodes } from '@neotavern/shared';
import type { AppContext, TypedApp } from '../types.js';

const PRE_RESTORE_PREFIX = 'pre-restore-';
/** Retention for automatic safety backups (ТЗ §10.4: «несколько последних»). */
const AUTO_BACKUP_RETENTION = 5;

export async function registerBackupRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  app.post('/api/v2/backups', { schema: { response: { 200: BackupSchema } } }, async () => {
    const id = `backup-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
    const dest = join(ctx.paths.backups, `${id}.db`);
    try {
      await ctx.database.backup(dest);
      const info = await stat(dest);
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
  // inside the backups directory with the .db convention are removable.
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
      // Safety backup of the current database before overwriting.
      const safety = join(
        ctx.paths.backups,
        `${PRE_RESTORE_PREFIX}${new Date().toISOString().replaceAll(/[:.]/g, '-')}.db`,
      );
      try {
        await ctx.database.backup(safety);
        rotatePrefixedBackups(ctx.paths.backups, PRE_RESTORE_PREFIX, AUTO_BACKUP_RETENTION);
        await ctx.database.restore(source);
        return { restored: true, restartRequired: false };
      } catch (cause) {
        throw new AppError({
          code: ErrorCodes.RESTORE_FAILED,
          params: { backupId: id },
          cause,
        });
      }
    },
  );
}
