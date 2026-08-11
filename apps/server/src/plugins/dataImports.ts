/** Complete SillyTavern user-data archive migration endpoint. */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  SillyTavernImportAnalysisSchema,
  SillyTavernImportExecuteSchema,
  SillyTavernImportResultSchema,
  type SillyTavernImportAnalysis,
  type SillyTavernImportExecute,
  type SillyTavernImportResult,
} from '@neotavern/contracts';
import { AppError, ErrorCodes, isAppError, uuidv7 } from '@neotavern/shared';
import { extractPackageArchive } from '../lib/packageArchive.js';
import { analyzeSillyTavernData, importSillyTavernData } from '../lib/sillyTavernImport.js';
import type { AppContext, TypedApp } from '../types.js';

export const MAX_SILLYTAVERN_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 500_000;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
const ANALYSIS_CACHE_PREFIX = 'sillytavern-analysis-';
export const SILLYTAVERN_ANALYSIS_TTL_MS = 30 * 60 * 1000;
const MAX_STAGED_ANALYSES = 3;

interface StagedAnalysis {
  response: SillyTavernImportAnalysis;
  temporaryRoot: string;
  extractedRoot: string;
  executing: boolean;
}

export async function registerDataImportRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  let importActive = false;
  let analysisActive = false;
  const staged = new Map<string, StagedAnalysis>();

  const removeStage = async (analysisId: string): Promise<void> => {
    const item = staged.get(analysisId);
    if (!item) return;
    staged.delete(analysisId);
    await rm(item.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  };
  const sweepExpired = async (): Promise<void> => {
    const now = Date.now();
    await Promise.all(
      [...staged.entries()]
        .filter(([, item]) => !item.executing && item.response.expiresAt <= now)
        .map(([analysisId]) => removeStage(analysisId)),
    );
  };

  await cleanupAbandonedAnalyses(ctx.paths.cache);
  const sweepTimer = setInterval(
    () => {
      void sweepExpired();
    },
    Math.min(60_000, SILLYTAVERN_ANALYSIS_TTL_MS),
  );
  sweepTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweepTimer);
    await Promise.all([...staged.keys()].map((analysisId) => removeStage(analysisId)));
  });

  app.post(
    '/api/v2/imports/sillytavern/analyze',
    {
      schema: {
        response: { 200: SillyTavernImportAnalysisSchema },
      },
    },
    async (request) => {
      await sweepExpired();
      if (analysisActive || importActive) {
        throw new AppError({
          code: ErrorCodes.CONFLICT,
          params: { reason: 'IMPORT_ANALYSIS_ALREADY_RUNNING' },
        });
      }
      if (staged.size >= MAX_STAGED_ANALYSES) {
        throw new AppError({
          code: ErrorCodes.CONFLICT,
          params: { reason: 'IMPORT_ANALYSIS_LIMIT_REACHED', limit: MAX_STAGED_ANALYSES },
        });
      }

      analysisActive = true;
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.raw.once('aborted', abort);
      let temporaryRoot: string | null = null;

      try {
        const upload = await request.file({
          throwFileSizeLimit: false,
          limits: { fileSize: MAX_SILLYTAVERN_ARCHIVE_BYTES },
        });
        if (!upload) {
          throw new AppError({
            code: ErrorCodes.BAD_REQUEST,
            params: { reason: 'FILE_REQUIRED' },
          });
        }

        temporaryRoot = await mkdtemp(join(ctx.paths.cache, ANALYSIS_CACHE_PREFIX));
        const archivePath = join(temporaryRoot, 'source.zip');
        const extractedRoot = join(temporaryRoot, 'extracted');
        const hash = createHash('sha256');
        const hashingStream = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          upload.file,
          hashingStream,
          createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
          { signal: controller.signal },
        );
        if (upload.file.truncated) {
          throw new AppError({
            code: ErrorCodes.FILE_TOO_LARGE,
            params: { limitBytes: MAX_SILLYTAVERN_ARCHIVE_BYTES },
          });
        }
        await assertZipSignature(archivePath);

        const sourceHash = hash.digest('hex');
        const sourceName = basename(upload.filename || 'sillytavern-data.zip');
        const archiveInfo = await stat(archivePath);
        const extracted = await extractPackageArchive(
          archivePath,
          extractedRoot,
          {
            maxArchiveBytes: MAX_SILLYTAVERN_ARCHIVE_BYTES,
            maxEntries: MAX_ARCHIVE_ENTRIES,
            maxEntryBytes: MAX_ENTRY_BYTES,
            maxExpandedBytes: MAX_EXPANDED_BYTES,
          },
          controller.signal,
        );
        const inspection = await analyzeSillyTavernData({
          repository: ctx.database.repos.dataImports,
          extractedRoot,
          signal: controller.signal,
        });
        const analysisId = uuidv7();
        const response: SillyTavernImportAnalysis = {
          analysisId,
          sourceHash,
          sourceName,
          expiresAt: Date.now() + SILLYTAVERN_ANALYSIS_TTL_MS,
          archiveAlreadyImported: Boolean(
            ctx.database.repos.dataImports.findCompletedJob(sourceHash),
          ),
          totalCompressedBytes: archiveInfo.size,
          totalExpandedBytes: extracted.expandedBytes,
          ...inspection,
        };
        staged.set(analysisId, {
          response,
          temporaryRoot,
          extractedRoot,
          executing: false,
        });
        temporaryRoot = null;
        return response;
      } catch (error) {
        if (isAppError(error)) throw error;
        if (controller.signal.aborted) {
          throw new AppError({ code: ErrorCodes.ABORTED, cause: error });
        }
        throw new AppError({ code: ErrorCodes.MIGRATION_FAILED, cause: error });
      } finally {
        request.raw.off('aborted', abort);
        if (temporaryRoot) {
          await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        analysisActive = false;
      }
    },
  );

  app.post(
    '/api/v2/imports/sillytavern/:analysisId/execute',
    {
      schema: {
        params: Type.Object({ analysisId: Type.String() }),
        body: SillyTavernImportExecuteSchema,
        response: { 200: SillyTavernImportResultSchema },
      },
    },
    async (request) => {
      await sweepExpired();
      const stage = staged.get(request.params.analysisId);
      if (!stage) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          params: { reason: 'IMPORT_ANALYSIS_NOT_FOUND', analysisId: request.params.analysisId },
        });
      }
      if (importActive || analysisActive || stage.executing) {
        throw new AppError({
          code: ErrorCodes.CONFLICT,
          params: { reason: 'IMPORT_ALREADY_RUNNING' },
        });
      }

      const input: SillyTavernImportExecute = request.body;
      importActive = true;
      stage.executing = true;
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.raw.once('aborted', abort);
      let jobId: string | null = null;

      try {
        jobId = ctx.database.repos.dataImports.startJob(
          stage.response.sourceHash,
          stage.response.sourceName,
          'sillytavern-data-zip',
        );
        const safetyBackupId = `pre-import-${jobId}`;
        try {
          await ctx.database.backup(join(ctx.paths.backups, `${safetyBackupId}.db`));
        } catch (cause) {
          throw new AppError({
            code: ErrorCodes.BACKUP_FAILED,
            params: { reason: 'PRE_IMPORT_BACKUP_FAILED' },
            cause,
          });
        }

        const imported = await importSillyTavernData({
          repository: ctx.database.repos.dataImports,
          paths: ctx.paths,
          extractedRoot: stage.extractedRoot,
          signal: controller.signal,
          categories: input.categories,
          conflictPolicy: input.conflictPolicy,
          executionId: jobId,
          cacheMetadata: ctx.database.repos.cacheMetadata,
          plugins: ctx.database.repos.plugins,
          providerConfigs: ctx.database.repos.providerConfigs,
        });
        const result: SillyTavernImportResult = {
          jobId,
          sourceHash: stage.response.sourceHash,
          sourceName: stage.response.sourceName,
          safetyBackupId,
          reusedArchive: false,
          selectedCategories: input.categories,
          conflictPolicy: input.conflictPolicy,
          ...imported,
        };
        ctx.database.repos.dataImports.completeJob(jobId, result);
        await removeStage(request.params.analysisId);
        return result;
      } catch (error) {
        if (jobId) {
          const errorCode = isAppError(error) ? error.code : ErrorCodes.MIGRATION_FAILED;
          ctx.database.repos.dataImports.failJob(jobId, errorCode);
        }
        if (isAppError(error)) throw error;
        if (controller.signal.aborted) {
          throw new AppError({ code: ErrorCodes.ABORTED, cause: error });
        }
        throw new AppError({ code: ErrorCodes.MIGRATION_FAILED, cause: error });
      } finally {
        request.raw.off('aborted', abort);
        stage.executing = false;
        importActive = false;
      }
    },
  );

  app.delete(
    '/api/v2/imports/sillytavern/:analysisId',
    {
      schema: {
        params: Type.Object({ analysisId: Type.String() }),
      },
    },
    async (request, reply) => {
      const stage = staged.get(request.params.analysisId);
      if (!stage) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          params: { reason: 'IMPORT_ANALYSIS_NOT_FOUND', analysisId: request.params.analysisId },
        });
      }
      if (stage.executing) {
        throw new AppError({
          code: ErrorCodes.CONFLICT,
          params: { reason: 'IMPORT_ALREADY_RUNNING' },
        });
      }
      await removeStage(request.params.analysisId);
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/v2/imports/sillytavern',
    {
      schema: {
        response: { 200: SillyTavernImportResultSchema },
      },
    },
    async (request) => {
      if (importActive || analysisActive) {
        throw new AppError({
          code: ErrorCodes.CONFLICT,
          params: { reason: 'IMPORT_ALREADY_RUNNING' },
        });
      }
      importActive = true;
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.raw.once('aborted', abort);
      let temporaryRoot: string | null = null;
      let jobId: string | null = null;

      try {
        const upload = await request.file({
          throwFileSizeLimit: false,
          limits: { fileSize: MAX_SILLYTAVERN_ARCHIVE_BYTES },
        });
        if (!upload) {
          throw new AppError({
            code: ErrorCodes.BAD_REQUEST,
            params: { reason: 'FILE_REQUIRED' },
          });
        }

        temporaryRoot = await mkdtemp(join(ctx.paths.cache, 'sillytavern-import-'));
        const archivePath = join(temporaryRoot, 'source.zip');
        const extractedRoot = join(temporaryRoot, 'extracted');
        const hash = createHash('sha256');
        const hashingStream = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          upload.file,
          hashingStream,
          createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
          { signal: controller.signal },
        );
        if (upload.file.truncated) {
          throw new AppError({
            code: ErrorCodes.FILE_TOO_LARGE,
            params: { limitBytes: MAX_SILLYTAVERN_ARCHIVE_BYTES },
          });
        }
        await assertZipSignature(archivePath);

        const sourceHash = hash.digest('hex');
        const sourceName = basename(upload.filename || 'sillytavern-data.zip');
        const previous = ctx.database.repos.dataImports.findCompletedJob(sourceHash);
        if (previous) {
          if (!Value.Check(SillyTavernImportResultSchema, previous.summary)) {
            throw new AppError({
              code: ErrorCodes.MIGRATION_FAILED,
              params: { reason: 'CORRUPT_IMPORT_JOB_SUMMARY', jobId: previous.id },
            });
          }
          return {
            ...(previous.summary as SillyTavernImportResult),
            reusedArchive: true,
          };
        }

        jobId = ctx.database.repos.dataImports.startJob(
          sourceHash,
          sourceName,
          'sillytavern-data-zip',
        );
        await extractPackageArchive(
          archivePath,
          extractedRoot,
          {
            maxArchiveBytes: MAX_SILLYTAVERN_ARCHIVE_BYTES,
            maxEntries: MAX_ARCHIVE_ENTRIES,
            maxEntryBytes: MAX_ENTRY_BYTES,
            maxExpandedBytes: MAX_EXPANDED_BYTES,
          },
          controller.signal,
        );
        const safetyBackupId = `pre-import-${jobId}`;
        try {
          await ctx.database.backup(join(ctx.paths.backups, `${safetyBackupId}.db`));
        } catch (cause) {
          throw new AppError({
            code: ErrorCodes.BACKUP_FAILED,
            params: { reason: 'PRE_IMPORT_BACKUP_FAILED' },
            cause,
          });
        }
        const imported = await importSillyTavernData({
          repository: ctx.database.repos.dataImports,
          paths: ctx.paths,
          extractedRoot,
          signal: controller.signal,
          cacheMetadata: ctx.database.repos.cacheMetadata,
          plugins: ctx.database.repos.plugins,
          providerConfigs: ctx.database.repos.providerConfigs,
        });
        const result: SillyTavernImportResult = {
          jobId,
          sourceHash,
          sourceName,
          safetyBackupId,
          reusedArchive: false,
          ...imported,
        };
        ctx.database.repos.dataImports.completeJob(jobId, result);
        return result;
      } catch (error) {
        if (jobId) {
          const errorCode = isAppError(error) ? error.code : ErrorCodes.MIGRATION_FAILED;
          ctx.database.repos.dataImports.failJob(jobId, errorCode);
        }
        if (isAppError(error)) throw error;
        if (controller.signal.aborted) {
          throw new AppError({ code: ErrorCodes.ABORTED, cause: error });
        }
        throw new AppError({ code: ErrorCodes.MIGRATION_FAILED, cause: error });
      } finally {
        request.raw.off('aborted', abort);
        if (temporaryRoot) {
          await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        importActive = false;
      }
    },
  );
}

async function assertZipSignature(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    const valid =
      bytesRead === 4 &&
      signature[0] === 0x50 &&
      signature[1] === 0x4b &&
      ((signature[2] === 0x03 && signature[3] === 0x04) ||
        (signature[2] === 0x05 && signature[3] === 0x06) ||
        (signature[2] === 0x07 && signature[3] === 0x08));
    if (!valid) {
      throw new AppError({
        code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
        params: { allowed: ['application/zip'] },
      });
    }
  } finally {
    await handle.close();
  }
}

async function cleanupAbandonedAnalyses(cacheRoot: string): Promise<void> {
  const entries = await readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - SILLYTAVERN_ANALYSIS_TTL_MS;
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(ANALYSIS_CACHE_PREFIX))
      .map(async (entry) => {
        const path = join(cacheRoot, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs <= cutoff) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
        }
      }),
  );
}
