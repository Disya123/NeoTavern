/** Preset routes: /api/v2/presets (ТЗ §10.2). */
import {
  IdSchema,
  AckSchema,
  GenerationPresetDataSchema,
  PresetCreateSchema,
  PresetSchema,
  PresetUpdateSchema,
  PromptTemplateSchema,
  hasCompletePromptBlockOrder,
  validateSchema,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { AppContext, TypedApp } from '../types.js';

export async function registerPresetRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.presets;

  app.get(
    '/api/v2/presets',
    {
      schema: {
        querystring: Type.Object({ kind: Type.Optional(Type.String({ maxLength: 50 })) }),
        response: { 200: Type.Object({ items: Type.Array(PresetSchema) }) },
      },
    },
    async (req) => ({ items: await repo.list(req.query.kind) }),
  );

  app.post(
    '/api/v2/presets',
    { schema: { body: PresetCreateSchema, response: { 200: PresetSchema } } },
    async (req) => {
      assertPresetData(req.body.kind, req.body.data);
      return repo.create(req.body);
    },
  );

  app.get(
    '/api/v2/presets/:id',
    {
      schema: { params: Type.Object({ id: IdSchema }), response: { 200: PresetSchema } },
    },
    async (req) => {
      const preset = await repo.getById(req.params.id);
      if (!preset) {
        throw new AppError({
          code: ErrorCodes.PRESET_NOT_FOUND,
          params: { presetId: req.params.id },
        });
      }
      return preset;
    },
  );

  app.patch(
    '/api/v2/presets/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: PresetUpdateSchema,
        response: { 200: PresetSchema },
      },
    },
    async (req) => {
      const existing = await repo.getById(req.params.id);
      if (!existing) {
        throw new AppError({
          code: ErrorCodes.PRESET_NOT_FOUND,
          params: { presetId: req.params.id },
        });
      }
      if (req.body.data !== undefined) assertPresetData(existing.kind, req.body.data);
      const updated = await repo.update(req.params.id, req.body);
      if (!updated) {
        throw new AppError({
          code: ErrorCodes.PRESET_NOT_FOUND,
          params: { presetId: req.params.id },
        });
      }
      return updated;
    },
  );

  app.delete(
    '/api/v2/presets/:id',
    {
      schema: { params: Type.Object({ id: IdSchema }), response: { 200: AckSchema } },
    },
    async (req) => {
      await repo.delete(req.params.id);
      return { ok: true };
    },
  );
}

function assertPresetData(kind: string, data: unknown): void {
  if (kind === 'generation') {
    const result = validateSchema(GenerationPresetDataSchema, data);
    if (!result.ok) throw result.error;
    return;
  }
  if (kind === 'prompt-template') {
    const result = validateSchema(PromptTemplateSchema, data);
    if (!result.ok) throw result.error;
    if (!hasCompletePromptBlockOrder(result.value)) {
      throw new AppError({
        code: ErrorCodes.VALIDATION,
        params: { path: 'data.blocks', reason: 'BLOCK_ORDER_INVALID' },
        message:
          'Prompt template preset must contain every host block once, unique custom ids, and fixed terminal anchors',
      });
    }
  }
}
