/** Memory/RAG routes: /api/v2/memories (ТЗ §4.4 Memory pipeline stage). */
import {
  IdSchema,
  AckSchema,
  MemoryCreateSchema,
  MemoryListQuerySchema,
  MemorySchema,
  MemoryUpdateSchema,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { AppContext, TypedApp } from '../types.js';

export async function registerMemoryRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.memories;

  app.get(
    '/api/v2/memories',
    {
      schema: {
        querystring: MemoryListQuerySchema,
        response: { 200: Type.Object({ items: Type.Array(MemorySchema) }) },
      },
    },
    async (req) => ({ items: await repo.list(req.query) }),
  );

  app.post(
    '/api/v2/memories',
    { schema: { body: MemoryCreateSchema, response: { 200: MemorySchema } } },
    async (req) => {
      if (req.body.scope === 'character' && !req.body.characterId) {
        throw new AppError({
          code: ErrorCodes.VALIDATION,
          params: { path: 'characterId' },
          message: 'character-scoped memory requires characterId',
        });
      }
      if (req.body.characterId) {
        const character = await ctx.database.repos.characters.getById(req.body.characterId);
        if (!character) {
          throw new AppError({
            code: ErrorCodes.CHARACTER_NOT_FOUND,
            params: { characterId: req.body.characterId },
          });
        }
      }
      return repo.create(req.body);
    },
  );

  app.patch(
    '/api/v2/memories/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: MemoryUpdateSchema,
        response: { 200: MemorySchema },
      },
    },
    async (req) => {
      const updated = await repo.update(req.params.id, req.body);
      if (!updated) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          params: { memoryId: req.params.id },
        });
      }
      return updated;
    },
  );

  app.delete(
    '/api/v2/memories/:id',
    {
      schema: { params: Type.Object({ id: IdSchema }), response: { 200: AckSchema } },
    },
    async (req) => {
      await repo.delete(req.params.id);
      return { ok: true };
    },
  );
}
