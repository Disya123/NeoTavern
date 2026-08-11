/** Character routes: /api/v2/characters. Cursor-paginated list, CRUD, trash. */
import {
  IdSchema,
  AckSchema,
  CharacterCreateSchema,
  CharacterSchema,
  CharacterSummarySchema,
  CharacterUpdateSchema,
  CharacterVersionSchema,
  CursorPageSchema,
  CharacterListQuerySchema,
  type Character,
  type CharacterSummary,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { AppContext, TypedApp } from '../types.js';

function toSummary(c: Character): CharacterSummary {
  return {
    id: c.id,
    name: c.name,
    avatar: c.avatar,
    description: c.description,
    tags: c.tags,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function registerCharacterRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.characters;

  app.get(
    '/api/v2/characters',
    {
      schema: {
        querystring: CharacterListQuerySchema,
        response: { 200: CursorPageSchema(CharacterSummarySchema) },
      },
    },
    async (req) => {
      const q = req.query;
      const page = await repo.list({
        cursor: q.cursor,
        limit: q.limit,
        tag: q.tag,
        q: q.q,
        sort: q.sort,
        includeDeleted: q.includeDeleted,
      });
      return {
        items: page.items.map(toSummary),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },
  );

  app.post(
    '/api/v2/characters',
    {
      schema: {
        body: CharacterCreateSchema,
        response: { 200: CharacterSchema },
      },
    },
    async (req) => repo.create(req.body),
  );

  app.get(
    '/api/v2/characters/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: CharacterSchema },
      },
    },
    async (req) => {
      const character = await repo.getById(req.params.id);
      if (!character)
        throw new AppError({
          code: ErrorCodes.CHARACTER_NOT_FOUND,
          params: { characterId: req.params.id },
        });
      return character;
    },
  );

  app.patch(
    '/api/v2/characters/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: CharacterUpdateSchema,
        response: { 200: CharacterSchema },
      },
    },
    async (req) => {
      const updated = await repo.update(req.params.id, req.body);
      if (!updated)
        throw new AppError({
          code: ErrorCodes.CHARACTER_NOT_FOUND,
          params: { characterId: req.params.id },
        });
      return updated;
    },
  );

  app.delete(
    '/api/v2/characters/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        querystring: Type.Object({ purge: Type.Optional(Type.Boolean()) }),
        response: { 200: AckSchema },
      },
    },
    async (req) => {
      // Default is soft delete (trash); ?purge=true empties the trash entry.
      if (req.query.purge) await repo.hardDelete(req.params.id);
      else await repo.softDelete(req.params.id);
      return { ok: true };
    },
  );

  app.post(
    '/api/v2/characters/:id/restore',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: AckSchema },
      },
    },
    async (req) => {
      const restored = await repo.restore(req.params.id);
      if (!restored)
        throw new AppError({
          code: ErrorCodes.CHARACTER_NOT_FOUND,
          params: { characterId: req.params.id },
        });
      return { ok: true };
    },
  );

  // Version history (ТЗ §10.2): snapshots are taken on every edit and on
  // import-replace; restoring snapshots the current state first.
  app.get(
    '/api/v2/characters/:id/versions',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: Type.Object({ items: Type.Array(CharacterVersionSchema) }) },
      },
    },
    async (req) => {
      await requireCharacter(repo, req.params.id);
      return { items: await repo.listVersions(req.params.id) };
    },
  );

  app.post(
    '/api/v2/characters/:id/versions/:versionId/restore',
    {
      schema: {
        params: Type.Object({ id: IdSchema, versionId: Type.String() }),
        response: { 200: CharacterSchema },
      },
    },
    async (req) => {
      await requireCharacter(repo, req.params.id);
      const restored = await repo.restoreVersion(req.params.id, req.params.versionId);
      if (!restored)
        throw new AppError({
          code: ErrorCodes.CHARACTER_NOT_FOUND,
          params: { characterId: req.params.id },
        });
      return restored;
    },
  );
}

async function requireCharacter(
  repo: AppContext['database']['repos']['characters'],
  id: string,
): Promise<void> {
  const character = await repo.getById(id);
  if (!character)
    throw new AppError({ code: ErrorCodes.CHARACTER_NOT_FOUND, params: { characterId: id } });
}
