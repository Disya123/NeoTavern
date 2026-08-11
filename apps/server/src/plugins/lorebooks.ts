/**
 * Lorebook routes: /api/v2/lorebooks (+ nested /entries). World info CRUD for
 * the prompt pipeline's Lorebook stage (ТЗ §4.1, §4.4, §12).
 */
import {
  IdSchema,
  AckSchema,
  CursorPageQuerySchema,
  CursorPageSchema,
  LorebookCreateSchema,
  LorebookEntryCreateSchema,
  LorebookEntrySchema,
  LorebookEntryUpdateSchema,
  LorebookSchema,
  LorebookUpdateSchema,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { AppContext, TypedApp } from '../types.js';

export async function registerLorebookRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.lorebooks;

  app.get(
    '/api/v2/lorebooks',
    {
      schema: {
        querystring: Type.Intersect([
          CursorPageQuerySchema,
          Type.Object({ characterId: Type.Optional(Type.String()) }),
        ]),
        response: { 200: CursorPageSchema(LorebookSchema) },
      },
    },
    async (req) =>
      repo.list({
        cursor: req.query.cursor,
        limit: req.query.limit,
        characterId: req.query.characterId,
      }),
  );

  app.post(
    '/api/v2/lorebooks',
    { schema: { body: LorebookCreateSchema, response: { 200: LorebookSchema } } },
    async (req) => repo.create(req.body),
  );

  app.get(
    '/api/v2/lorebooks/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: LorebookSchema },
      },
    },
    async (req) => {
      const book = await repo.getById(req.params.id);
      if (!book) {
        throw new AppError({
          code: ErrorCodes.LOREBOOK_NOT_FOUND,
          params: { lorebookId: req.params.id },
        });
      }
      return book;
    },
  );

  app.patch(
    '/api/v2/lorebooks/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: LorebookUpdateSchema,
        response: { 200: LorebookSchema },
      },
    },
    async (req) => {
      const updated = await repo.update(req.params.id, req.body);
      if (!updated) {
        throw new AppError({
          code: ErrorCodes.LOREBOOK_NOT_FOUND,
          params: { lorebookId: req.params.id },
        });
      }
      return updated;
    },
  );

  app.delete(
    '/api/v2/lorebooks/:id',
    {
      schema: { params: Type.Object({ id: IdSchema }), response: { 200: AckSchema } },
    },
    async (req) => {
      await repo.softDelete(req.params.id);
      return { ok: true };
    },
  );

  app.post(
    '/api/v2/lorebooks/:id/restore',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: LorebookSchema },
      },
    },
    async (req) => {
      const restored = await repo.restore(req.params.id);
      if (!restored) {
        throw new AppError({
          code: ErrorCodes.LOREBOOK_NOT_FOUND,
          params: { lorebookId: req.params.id },
        });
      }
      return restored;
    },
  );

  // --- entries ---

  app.get(
    '/api/v2/lorebooks/:id/entries',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: Type.Object({ items: Type.Array(LorebookEntrySchema) }) },
      },
    },
    async (req) => {
      await requireBook(repo, req.params.id);
      return { items: await repo.listEntries(req.params.id) };
    },
  );

  app.post(
    '/api/v2/lorebooks/:id/entries',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: LorebookEntryCreateSchema,
        response: { 200: LorebookEntrySchema },
      },
    },
    async (req) => {
      await requireBook(repo, req.params.id);
      return repo.createEntry(req.params.id, req.body);
    },
  );

  app.patch(
    '/api/v2/lorebooks/:id/entries/:entryId',
    {
      schema: {
        params: Type.Object({ id: IdSchema, entryId: Type.String() }),
        body: LorebookEntryUpdateSchema,
        response: { 200: LorebookEntrySchema },
      },
    },
    async (req) => {
      const updated = await repo.updateEntry(req.params.id, req.params.entryId, req.body);
      if (!updated) {
        throw new AppError({
          code: ErrorCodes.LORE_ENTRY_NOT_FOUND,
          params: { lorebookId: req.params.id, entryId: req.params.entryId },
        });
      }
      return updated;
    },
  );

  app.delete(
    '/api/v2/lorebooks/:id/entries/:entryId',
    {
      schema: {
        params: Type.Object({ id: IdSchema, entryId: Type.String() }),
        response: { 200: AckSchema },
      },
    },
    async (req) => {
      const deleted = await repo.deleteEntry(req.params.id, req.params.entryId);
      if (!deleted) {
        throw new AppError({
          code: ErrorCodes.LORE_ENTRY_NOT_FOUND,
          params: { lorebookId: req.params.id, entryId: req.params.entryId },
        });
      }
      return { ok: true };
    },
  );
}

type LorebookRepo = AppContext['database']['repos']['lorebooks'];

async function requireBook(repo: LorebookRepo, id: string): Promise<void> {
  const book = await repo.getById(id);
  if (!book) {
    throw new AppError({ code: ErrorCodes.LOREBOOK_NOT_FOUND, params: { lorebookId: id } });
  }
}
