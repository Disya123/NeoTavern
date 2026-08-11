/** Character-owned image gallery backed by content-addressed originals and attachment metadata. */
import { extname } from 'node:path';
import { access } from 'node:fs/promises';
import {
  IdSchema,
  AckSchema,
  CharacterGalleryImageSchema,
  CharacterGallerySchema,
  type CharacterGalleryImage,
} from '@neotavern/contracts';
import type { AttachmentRecord } from '@neotavern/db';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import { storeAvatar } from '../lib/fileStore.js';
import type { AppContext, TypedApp } from '../types.js';

const OWNER_TYPE = 'character.gallery';
const MAX_GALLERY_FILE_BYTES = 25 * 1024 * 1024;

function mimeForUrl(url: string): string {
  switch (extname(url)) {
    case '.png':
      return 'image/png';
    case '.jpg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function galleryImage(record: AttachmentRecord): CharacterGalleryImage {
  const originalUrl =
    typeof record.metadata['originalUrl'] === 'string' ? record.metadata['originalUrl'] : '';
  const thumbnailUrl =
    typeof record.metadata['thumbnailUrl'] === 'string' ? record.metadata['thumbnailUrl'] : '';
  return {
    id: record.id,
    characterId: record.ownerId,
    name: record.logicalName,
    mime: record.mime,
    sizeBytes: record.sizeBytes,
    originalUrl,
    thumbnailUrl,
    createdAt: record.createdAt,
  };
}

async function requireCharacter(ctx: AppContext, id: string): Promise<void> {
  const character = await ctx.database.repos.characters.getById(id);
  if (!character) {
    throw new AppError({
      code: ErrorCodes.CHARACTER_NOT_FOUND,
      params: { characterId: id },
    });
  }
}

function localAvatarHash(avatar: string | null): string | null {
  return (
    avatar?.match(
      /\/api\/v2\/assets\/(?:avatars|thumbnails)\/([a-f0-9]{64})(?:-\d+-v\d+)?\.[a-z0-9]+$/,
    )?.[1] ?? null
  );
}

async function avatarOriginalAssetUrl(
  ctx: AppContext,
  avatar: string | null,
): Promise<string | null> {
  const hash = localAvatarHash(avatar);
  if (!hash) return null;
  for (const extension of ['.png', '.jpg', '.webp', '.gif']) {
    try {
      await access(`${ctx.paths.avatars}/${hash}${extension}`);
      return `/api/v2/assets/avatars/${hash}${extension}`;
    } catch {
      // Try the next supported original format. Missing files are expected.
    }
  }
  return null;
}

export async function registerCharacterGalleryRoutes(
  app: TypedApp,
  ctx: AppContext,
): Promise<void> {
  app.get(
    '/api/v2/characters/:id/avatar-original',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
      },
    },
    async (request, reply) => {
      const character = await ctx.database.repos.characters.getById(request.params.id);
      if (!character) {
        throw new AppError({
          code: ErrorCodes.CHARACTER_NOT_FOUND,
          params: { characterId: request.params.id },
        });
      }
      const originalUrl = await avatarOriginalAssetUrl(ctx, character.avatar);
      if (!originalUrl) {
        throw new AppError({
          code: ErrorCodes.FILE_NOT_FOUND,
          params: { characterId: request.params.id },
        });
      }
      return reply.redirect(originalUrl);
    },
  );

  app.get(
    '/api/v2/characters/:id/gallery',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        querystring: Type.Object({
          sort: Type.Optional(Type.Union([Type.Literal('oldest'), Type.Literal('newest')])),
        }),
        response: { 200: CharacterGallerySchema },
      },
    },
    async (request) => {
      await requireCharacter(ctx, request.params.id);
      const records = await ctx.database.repos.attachments.listForOwner(
        OWNER_TYPE,
        request.params.id,
      );
      if (request.query.sort === 'newest') records.reverse();
      return { items: records.map(galleryImage) };
    },
  );

  app.post(
    '/api/v2/characters/:id/gallery',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: CharacterGalleryImageSchema },
      },
    },
    async (request) => {
      await requireCharacter(ctx, request.params.id);
      const upload = await request.file({
        throwFileSizeLimit: false,
        limits: { fileSize: MAX_GALLERY_FILE_BYTES },
      });
      if (!upload) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'FILE_REQUIRED' },
        });
      }
      const bytes = await upload.toBuffer();
      if (upload.file.truncated) {
        throw new AppError({
          code: ErrorCodes.FILE_TOO_LARGE,
          params: { limitBytes: MAX_GALLERY_FILE_BYTES },
        });
      }

      const stored = await storeAvatar(bytes, ctx.paths, 512, (record) =>
        ctx.database.repos.cacheMetadata.record(record),
      );
      const originalName = stored.originalUrl.split('/').at(-1) ?? stored.hash;
      const record = await ctx.database.repos.attachments.record({
        ownerType: OWNER_TYPE,
        ownerId: request.params.id,
        logicalName: upload.filename,
        relativePath: `avatars/${originalName}`,
        contentHash: stored.hash,
        mime: mimeForUrl(stored.originalUrl),
        sizeBytes: bytes.byteLength,
        metadata: {
          originalUrl: stored.originalUrl,
          thumbnailUrl: stored.thumbnailUrl,
        },
      });
      return galleryImage(record);
    },
  );

  app.delete(
    '/api/v2/characters/:id/gallery/:imageId',
    {
      schema: {
        params: Type.Object({ id: IdSchema, imageId: Type.String() }),
        response: { 200: AckSchema },
      },
    },
    async (request) => {
      await requireCharacter(ctx, request.params.id);
      const records = await ctx.database.repos.attachments.listForOwner(
        OWNER_TYPE,
        request.params.id,
      );
      if (!records.some((record) => record.id === request.params.imageId)) {
        throw new AppError({
          code: ErrorCodes.FILE_NOT_FOUND,
          params: { imageId: request.params.imageId },
        });
      }
      await ctx.database.repos.attachments.delete(request.params.imageId);
      return { ok: true };
    },
  );
}
