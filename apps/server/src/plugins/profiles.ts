/**
 * Profile routes: /api/v2/profiles (ТЗ §10.2, §10.4). Includes the portable
 * profile export — a single archive with a database snapshot and user files.
 */
import {
  IdSchema,
  ProfileExportResponseSchema,
  ProfileListResponseSchema,
  ProfileSchema,
  ProfileUpdateSchema,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { AppContext, TypedApp } from '../types.js';
import { buildProfileExportArchive } from '../lib/profileExport.js';
import { APP_VERSION } from './meta.js';

export async function registerProfileRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.profiles;

  app.get(
    '/api/v2/profiles',
    { schema: { response: { 200: ProfileListResponseSchema } } },
    async () => {
      const items = await repo.list();
      const current = items[0];
      if (!current) {
        throw new AppError({ code: ErrorCodes.INTERNAL, message: 'Profile store is empty' });
      }
      return { items, currentId: current.id };
    },
  );

  // Portable profile archive (ТЗ §10.4). Registered before :id — Fastify
  // prefers static segments anyway, but the order keeps intent explicit.
  app.get(
    '/api/v2/profiles/export',
    { schema: { response: { 200: ProfileExportResponseSchema } } },
    async (_req, reply) => {
      const profile = await repo.getCurrent();
      const archive = await buildProfileExportArchive({
        database: ctx.database,
        paths: ctx.paths,
        profile: { id: profile.id, name: profile.name },
        appVersion: APP_VERSION,
      });
      reply.raw.on('close', () => {
        // A rejected cleanup (EBUSY/EPERM under Windows file locks or an AV)
        // must not become an unhandled rejection — the export already
        // succeeded; the temp dir is disposable.
        archive.cleanup().catch((error) => {
          ctx.logger.warn(
            `profile export temp cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      });
      return reply
        .header('Content-Type', 'application/zip')
        .header(
          'Content-Disposition',
          `attachment; filename="neotavern-profile-${new Date().toISOString().slice(0, 10)}.zip"`,
        )
        .send(archive.zip.outputStream);
    },
  );

  app.patch(
    '/api/v2/profiles/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: ProfileUpdateSchema,
        response: { 200: ProfileSchema },
      },
    },
    async (req) => {
      const updated = await repo.rename(req.params.id, req.body.name);
      if (!updated) {
        throw new AppError({
          code: ErrorCodes.PROFILE_NOT_FOUND,
          params: { profileId: req.params.id },
        });
      }
      return updated;
    },
  );
}
