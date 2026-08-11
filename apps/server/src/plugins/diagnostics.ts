/**
 * Local, redacted diagnostics and regenerable-cache maintenance.
 *
 * The report exposes aggregate counts only: no logs, absolute paths,
 * provider settings, credentials or user-authored content are serialized.
 */
import { mkdir, opendir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CacheCleanupResultSchema,
  DiagnosticsSnapshotSchema,
  type DiagnosticsSnapshot,
} from '@neotavern/contracts';
import type { AppContext, TypedApp } from '../types.js';
import { API_VERSION, APP_VERSION } from './meta.js';

interface DirectoryUsage {
  files: number;
  bytes: number;
}

export async function registerDiagnosticRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v2/diagnostics',
    { schema: { response: { 200: DiagnosticsSnapshotSchema } } },
    async (): Promise<DiagnosticsSnapshot> => {
      const [database, dbFile, files, cache, backups, disk] = await Promise.all([
        Promise.resolve(ctx.database.diagnostics()),
        stat(ctx.paths.dbFile).catch(() => null),
        measureDirectory(ctx.paths.files),
        measureDirectory(ctx.paths.cache),
        measureDirectory(ctx.paths.backups),
        statfs(ctx.paths.root).catch(() => null),
      ]);

      return {
        formatVersion: 1,
        generatedAt: Date.now(),
        app: {
          version: APP_VERSION,
          apiVersion: API_VERSION,
          nodeVersion: process.versions.node,
          platform: process.platform,
          architecture: process.arch,
          uptimeSeconds: process.uptime(),
          remoteAccess: ctx.config.remoteAccess,
        },
        database: {
          integrity: database.integrity,
          schemaVersion: database.schemaVersion,
          migrationCount: database.migrationCount,
          sizeBytes: dbFile?.size ?? 0,
          entities: database.entities,
        },
        storage: {
          filesBytes: files.bytes,
          cacheBytes: cache.bytes,
          backupsBytes: backups.bytes,
          freeBytes: disk ? disk.bavail * disk.bsize : null,
        },
        providers: {
          registeredKinds: ctx.providers.kinds().toSorted(),
          configured: database.providers.configured,
          enabled: database.providers.enabled,
        },
        plugins: database.plugins,
        themes: {
          ...database.themes,
          safeModeAvailable: true,
        },
        privacy: {
          redacted: true,
          secretsIncluded: false,
          userContentIncluded: false,
          absolutePathsIncluded: false,
          logsIncluded: false,
        },
      };
    },
  );

  app.delete(
    '/api/v2/diagnostics/cache',
    { schema: { response: { 200: CacheCleanupResultSchema } } },
    async () => {
      const before = await measureDirectory(ctx.paths.thumbnails);
      const directory = await opendir(ctx.paths.thumbnails).catch(() => null);
      if (directory) {
        for await (const entry of directory) {
          await rm(join(ctx.paths.thumbnails, entry.name), { recursive: true, force: true });
        }
      }
      await mkdir(ctx.paths.thumbnails, { recursive: true });
      const metadataRowsRemoved = ctx.database.clearCacheMetadata();
      return {
        removedFiles: before.files,
        removedBytes: before.bytes,
        metadataRowsRemoved,
      };
    },
  );
}

async function measureDirectory(root: string): Promise<DirectoryUsage> {
  const directory = await opendir(root).catch(() => null);
  if (!directory) return { files: 0, bytes: 0 };

  let files = 0;
  let bytes = 0;
  for await (const entry of directory) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await measureDirectory(path);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      const info = await stat(path).catch(() => null);
      if (info) {
        files += 1;
        bytes += info.size;
      }
    }
  }
  return { files, bytes };
}
