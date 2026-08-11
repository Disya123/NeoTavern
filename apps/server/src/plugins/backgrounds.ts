/**
 * Chat background (wallpaper) management.
 *
 * The directory `data/files/backgrounds/` is authoritative: the list endpoint
 * scans it (so ST1-imported originals appear automatically), uploads are
 * content-addressed, and deleting removes the original plus its regenerable
 * thumbnail and detaches the reference from every chat.
 */
import { createReadStream } from 'node:fs';
import { access, readdir, stat, unlink } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { FastifyReply } from 'fastify';
import {
  AckSchema,
  BackgroundItemSchema,
  BackgroundListSchema,
  type BackgroundItem,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import {
  backgroundThumbnailFilename,
  ensureBackgroundThumbnail,
  safeBackgroundPath,
  storeBackground,
} from '../lib/fileStore.js';
import type { AppContext, TypedApp } from '../types.js';

const MAX_BACKGROUND_FILE_BYTES = 25 * 1024 * 1024;
const BACKGROUND_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function contentTypeFor(filename: string): string {
  const extension = extname(filename).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  return 'image/webp';
}

function backgroundItem(
  filename: string,
  thumbnailUrl: string,
  sizeBytes: number,
  createdAt: number,
): BackgroundItem {
  return {
    id: filename,
    name: filename,
    originalUrl: `/api/v2/assets/backgrounds/${encodeURIComponent(filename)}`,
    thumbnailUrl,
    sizeBytes,
    createdAt,
  };
}

async function ensureSafeOriginal(ctx: AppContext, filename: string): Promise<string> {
  const path = safeBackgroundPath(ctx.paths.backgrounds, filename, BACKGROUND_EXTENSIONS);
  if (!path) {
    throw new AppError({ code: ErrorCodes.FILE_NOT_FOUND, params: { filename } });
  }
  try {
    await access(path);
  } catch (cause) {
    throw new AppError({ code: ErrorCodes.FILE_NOT_FOUND, params: { filename }, cause });
  }
  return path;
}

async function sendBackground(
  reply: FastifyReply,
  path: string,
  filename: string,
): Promise<unknown> {
  return reply
    .type(contentTypeFor(filename))
    .header('Cache-Control', 'public, max-age=3600')
    .send(createReadStream(path));
}

export async function registerBackgroundRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const recordCache = (
    record: Parameters<AppContext['database']['repos']['cacheMetadata']['record']>[0],
  ) => ctx.database.repos.cacheMetadata.record(record);

  app.get(
    '/api/v2/backgrounds',
    { schema: { response: { 200: BackgroundListSchema } } },
    async () => {
      const entries = await readdir(ctx.paths.backgrounds, { withFileTypes: true }).catch(() => []);
      const items: BackgroundItem[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        if (!safeBackgroundPath(ctx.paths.backgrounds, entry.name, BACKGROUND_EXTENSIONS)) continue;
        const info = await stat(resolve(ctx.paths.backgrounds, entry.name)).catch(() => null);
        if (!info) continue;
        const thumbnailUrl =
          (await ensureBackgroundThumbnail(entry.name, ctx.paths, recordCache)) ?? '';
        items.push(backgroundItem(entry.name, thumbnailUrl, info.size, info.mtimeMs));
      }
      // Stable ordering: newest file first.
      items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      return { items };
    },
  );

  app.post(
    '/api/v2/backgrounds',
    { schema: { response: { 200: BackgroundItemSchema } } },
    async (request) => {
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.startsWith('multipart/form-data')) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'FILE_REQUIRED' },
        });
      }
      const upload = await request.file({
        throwFileSizeLimit: false,
        limits: { fileSize: MAX_BACKGROUND_FILE_BYTES },
      });
      if (!upload) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'FILE_REQUIRED' },
        });
      }
      if (upload.file.truncated) {
        throw new AppError({
          code: ErrorCodes.FILE_TOO_LARGE,
          params: { limitBytes: MAX_BACKGROUND_FILE_BYTES },
        });
      }
      if (upload.mimetype && !IMAGE_MIME_TYPES.has(upload.mimetype)) {
        throw new AppError({
          code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
          params: { allowed: [...IMAGE_MIME_TYPES] },
        });
      }

      const bytes = await upload.toBuffer();
      const stored = await storeBackground(bytes, ctx.paths, recordCache);
      const info = await stat(resolve(ctx.paths.backgrounds, stored.filename));
      return backgroundItem(stored.filename, stored.thumbnailUrl, info.size, info.mtimeMs);
    },
  );

  app.delete(
    '/api/v2/backgrounds/:id',
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: { 200: AckSchema },
      },
    },
    async (request) => {
      const filename = request.params.id;
      const path = await ensureSafeOriginal(ctx, filename);
      try {
        await unlink(path);
      } catch (cause) {
        throw new AppError({ code: ErrorCodes.FILE_NOT_FOUND, params: { filename }, cause });
      }
      await unlink(resolve(ctx.paths.thumbnails, backgroundThumbnailFilename(filename))).catch(
        () => undefined,
      );
      await ctx.database.repos.chats.clearBackgroundReference(filename);
      return { ok: true };
    },
  );

  app.get(
    '/api/v2/assets/backgrounds/:filename',
    {
      schema: {
        params: Type.Object({ filename: Type.String() }),
      },
    },
    async (request, reply) => {
      const path = await ensureSafeOriginal(ctx, request.params.filename);
      return sendBackground(reply, path, request.params.filename);
    },
  );
}
