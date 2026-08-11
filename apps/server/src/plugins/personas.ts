/** Persona routes: /api/v2/personas. */
import {
  IdSchema,
  AckSchema,
  PersonaCreateSchema,
  PersonaSchema,
  PersonaUpdateSchema,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { AppContext, TypedApp } from '../types.js';

export async function registerPersonaRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.personas;

  app.get(
    '/api/v2/personas',
    { schema: { response: { 200: Type.Object({ items: Type.Array(PersonaSchema) }) } } },
    async () => ({ items: await repo.list() }),
  );

  app.post(
    '/api/v2/personas',
    { schema: { body: PersonaCreateSchema, response: { 200: PersonaSchema } } },
    async (req) => repo.create(req.body),
  );

  app.get(
    '/api/v2/personas/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: PersonaSchema },
      },
    },
    async (req) => {
      const persona = await repo.getById(req.params.id);
      if (!persona)
        throw new AppError({
          code: ErrorCodes.PERSONA_NOT_FOUND,
          params: { personaId: req.params.id },
        });
      return persona;
    },
  );

  app.patch(
    '/api/v2/personas/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: PersonaUpdateSchema,
        response: { 200: PersonaSchema },
      },
    },
    async (req) => {
      const updated = await repo.update(req.params.id, req.body);
      if (!updated)
        throw new AppError({
          code: ErrorCodes.PERSONA_NOT_FOUND,
          params: { personaId: req.params.id },
        });
      return updated;
    },
  );

  app.delete(
    '/api/v2/personas/:id',
    {
      schema: { params: Type.Object({ id: IdSchema }), response: { 200: AckSchema } },
    },
    async (req) => {
      await repo.delete(req.params.id);
      return { ok: true };
    },
  );
}
