/** Character Card import/export and content-addressed avatar delivery. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyReply } from 'fastify';
import { CharacterImportResultSchema, IdSchema, type CharacterCreate } from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import {
  embedCharacterCardInPng,
  exportCharacterCard,
  parseCharacterCard,
} from '../lib/characterCards.js';
import { renderAvatarPng, safeAssetPath, storeAvatar } from '../lib/fileStore.js';
import type { AppContext, TypedApp } from '../types.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const AVATAR_EXTENSIONS = new Set(['.png', '.jpg', '.webp', '.gif']);
const THUMBNAIL_EXTENSIONS = new Set(['.webp']);

async function readLocalAvatar(avatar: string | null, ctx: AppContext): Promise<Buffer | null> {
  if (!avatar) return null;
  const match = avatar.match(
    /\/api\/v2\/assets\/(?:avatars|thumbnails)\/([a-f0-9]{64})(?:-\d+-v\d+)?\.[a-z0-9]+$/,
  );
  const hash = match?.[1];
  if (!hash) return null;
  for (const extension of AVATAR_EXTENSIONS) {
    const path = safeAssetPath(ctx.paths.avatars, `${hash}${extension}`, AVATAR_EXTENSIONS);
    if (!path) continue;
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function detectCardKind(bytes: Buffer): 'json' | 'png' {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
  const first = bytes.toString('utf8', 0, Math.min(bytes.length, 256)).trimStart()[0];
  if (first === '{') return 'json';
  throw new AppError({
    code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
    params: { allowed: ['application/json', 'image/png'] },
  });
}

function withImportMetadata(
  character: CharacterCreate,
  sourceHash: string,
  sourceFormat: string,
): CharacterCreate {
  return {
    ...character,
    ext: {
      ...(character.ext ?? {}),
      _st2: {
        importHash: sourceHash,
        sourceFormat,
      },
    },
  };
}

async function sendAsset(
  reply: FastifyReply,
  base: string,
  filename: string,
  allowedExtensions: ReadonlySet<string>,
): Promise<unknown> {
  const path = safeAssetPath(base, filename, allowedExtensions);
  if (!path) {
    throw new AppError({ code: ErrorCodes.FILE_NOT_FOUND, params: { filename } });
  }
  try {
    await access(path);
  } catch (cause) {
    throw new AppError({
      code: ErrorCodes.FILE_NOT_FOUND,
      params: { filename },
      cause,
    });
  }
  const contentType =
    extname(filename) === '.png'
      ? 'image/png'
      : extname(filename) === '.jpg'
        ? 'image/jpeg'
        : extname(filename) === '.gif'
          ? 'image/gif'
          : 'image/webp';
  return reply
    .type(contentType)
    .header('Cache-Control', 'public, max-age=31536000, immutable')
    .send(createReadStream(path));
}

export async function registerCharacterTransferRoutes(
  app: TypedApp,
  ctx: AppContext,
): Promise<void> {
  app.post(
    '/api/v2/characters/import',
    {
      schema: {
        response: { 200: CharacterImportResultSchema },
      },
    },
    async (request) => {
      const upload = await request.file({
        throwFileSizeLimit: false,
        limits: { fileSize: 25 * 1024 * 1024 },
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
          params: { limitBytes: 25 * 1024 * 1024 },
        });
      }
      const sourceHash = createHash('sha256').update(bytes).digest('hex');
      const kind = detectCardKind(bytes);
      const parsed = parseCharacterCard(bytes, kind);

      let avatar: string | undefined;
      if (kind === 'png') {
        const stored = await storeAvatar(bytes, ctx.paths, 256, (record) =>
          ctx.database.repos.cacheMetadata.record(record),
        );
        avatar = stored.thumbnailUrl;
      }

      const existing = await ctx.database.repos.characters.findByImportHash(sourceHash);
      if (existing) {
        return {
          character: existing,
          created: false,
          sourceHash,
          warnings: parsed.warnings,
        };
      }

      const character = await ctx.database.repos.characters.create(
        withImportMetadata({ ...parsed.character, avatar }, sourceHash, parsed.sourceFormat),
      );
      return {
        character,
        created: true,
        sourceHash,
        warnings: parsed.warnings,
      };
    },
  );

  app.get(
    '/api/v2/characters/:id/export',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        querystring: Type.Object({
          format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('png')])),
        }),
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
      if (request.query.format === 'png') {
        const avatar = await readLocalAvatar(character.avatar, ctx);
        const png = embedCharacterCardInPng(await renderAvatarPng(avatar), character);
        return reply
          .type('image/png')
          .header('Content-Disposition', `attachment; filename="character-${character.id}.png"`)
          .send(png);
      }
      reply.header('Content-Disposition', `attachment; filename="character-${character.id}.json"`);
      return exportCharacterCard(character);
    },
  );

  app.get(
    '/api/v2/assets/avatars/:filename',
    {
      schema: {
        params: Type.Object({ filename: Type.String() }),
      },
    },
    async (request, reply) =>
      sendAsset(reply, ctx.paths.avatars, request.params.filename, AVATAR_EXTENSIONS),
  );

  app.get(
    '/api/v2/assets/thumbnails/:filename',
    {
      schema: {
        params: Type.Object({ filename: Type.String() }),
      },
    },
    async (request, reply) =>
      sendAsset(reply, ctx.paths.thumbnails, request.params.filename, THUMBNAIL_EXTENSIONS),
  );
}
