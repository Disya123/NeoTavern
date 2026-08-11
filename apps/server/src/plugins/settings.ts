/** Settings routes: /api/v2/settings. */
import {
  AppSettingsSchema,
  AppSettingsUpdateSchema,
  InstructFormatListResponseSchema,
  hasCompletePromptBlockOrder,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import type { AppContext, TypedApp } from '../types.js';
import { listInstructFormats } from '../pipeline/instruct.js';

export async function registerSettingsRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.settings;

  app.get('/api/v2/settings', { schema: { response: { 200: AppSettingsSchema } } }, async () =>
    repo.getAll(),
  );

  // Built-in instruct formats selectable via settings.instructFormatId
  // (ТЗ §4.4 — ChatML/Llama3/Alpaca/… must be reachable from configuration).
  app.get(
    '/api/v2/settings/instruct-formats',
    { schema: { response: { 200: InstructFormatListResponseSchema } } },
    async () => ({
      formats: listInstructFormats().map((format) => ({
        id: format.id,
        version: format.version,
        stopStrings: format.stopStrings,
      })),
    }),
  );

  app.patch(
    '/api/v2/settings',
    { schema: { body: AppSettingsUpdateSchema, response: { 200: AppSettingsSchema } } },
    async (req) => {
      if (req.body.contextStrategy !== undefined) {
        try {
          ctx.contextStrategies.resolve(req.body.contextStrategy);
        } catch {
          throw new AppError({
            code: ErrorCodes.VALIDATION,
            params: {
              path: 'contextStrategy',
              value: req.body.contextStrategy,
            },
            message: 'Unknown context strategy',
          });
        }
      }
      if (req.body.instructFormatId !== undefined && req.body.instructFormatId !== null) {
        const known = new Set(listInstructFormats().map((format) => format.id));
        if (!known.has(req.body.instructFormatId)) {
          throw new AppError({
            code: ErrorCodes.VALIDATION,
            params: { path: 'instructFormatId', value: req.body.instructFormatId },
            message: 'Unknown instruct format',
          });
        }
      }
      if (
        req.body.promptTemplate !== undefined &&
        !hasCompletePromptBlockOrder(req.body.promptTemplate)
      ) {
        throw new AppError({
          code: ErrorCodes.VALIDATION,
          params: { path: 'promptTemplate.blocks', reason: 'BLOCK_ORDER_INVALID' },
          message:
            'Prompt template must contain every host block once, unique custom ids, and fixed terminal anchors',
        });
      }
      if (
        req.body.activeGenerationPresetId !== undefined &&
        req.body.activeGenerationPresetId !== null
      ) {
        const preset = await ctx.database.repos.presets.getById(req.body.activeGenerationPresetId);
        if (preset?.kind !== 'generation') {
          throw new AppError({
            code: ErrorCodes.PRESET_NOT_FOUND,
            params: { presetId: req.body.activeGenerationPresetId, kind: 'generation' },
          });
        }
      }
      if (
        req.body.activePromptTemplatePresetId !== undefined &&
        req.body.activePromptTemplatePresetId !== null
      ) {
        const preset = await ctx.database.repos.presets.getById(
          req.body.activePromptTemplatePresetId,
        );
        if (preset?.kind !== 'prompt-template') {
          throw new AppError({
            code: ErrorCodes.PRESET_NOT_FOUND,
            params: {
              presetId: req.body.activePromptTemplatePresetId,
              kind: 'prompt-template',
            },
          });
        }
      }
      if (req.body.themeId !== undefined) {
        if (req.body.themeId === null) {
          ctx.database.repos.themes.resetActive();
        } else if (!ctx.database.repos.themes.activate(req.body.themeId)) {
          throw new AppError({
            code: ErrorCodes.THEME_NOT_FOUND,
            params: { themeId: req.body.themeId },
          });
        }
      }
      const settingsPatch = { ...req.body };
      delete settingsPatch.themeId;
      return repo.patch(settingsPatch);
    },
  );
}
