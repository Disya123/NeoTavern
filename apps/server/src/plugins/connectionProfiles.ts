/** Connection-profile routes: saved local provider bundles and atomic apply. */
import {
  AckSchema,
  additionalParamIssues,
  ConnectionProfileApplyResultSchema,
  ConnectionProfileCreateSchema,
  ConnectionProfileCreatedSchema,
  ConnectionProfileFields,
  ConnectionProfileListSchema,
  ConnectionProfileSchema,
  ConnectionProfileUpdateSchema,
  IdSchema,
  type ConnectionProfile,
  type ConnectionProfileField,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { AppContext, TypedApp } from '../types.js';
import { assertProviderConfigValid } from './providers.js';

const profileParams = Type.Object({ id: IdSchema });

export async function registerConnectionProfileRoutes(
  app: TypedApp,
  ctx: AppContext,
): Promise<void> {
  const repo = ctx.database.repos.connectionProfiles;

  app.get(
    '/api/v2/connection-profiles',
    { schema: { response: { 200: ConnectionProfileListSchema } } },
    async () => ({ items: await repo.list() }),
  );

  app.post(
    '/api/v2/connection-profiles',
    {
      schema: {
        body: ConnectionProfileCreateSchema,
        response: { 200: ConnectionProfileCreatedSchema },
      },
    },
    async (req) => {
      const profile = await repo.create(req.body);
      return { id: profile.id };
    },
  );

  app.get(
    '/api/v2/connection-profiles/:id',
    { schema: { params: profileParams, response: { 200: ConnectionProfileSchema } } },
    async (req) => requireProfile(await repo.getById(req.params.id), req.params.id),
  );

  app.patch(
    '/api/v2/connection-profiles/:id',
    {
      schema: {
        params: profileParams,
        body: ConnectionProfileUpdateSchema,
        response: { 200: ConnectionProfileSchema },
      },
    },
    async (req) => {
      const profile = await repo.update(req.params.id, req.body);
      return requireProfile(profile, req.params.id);
    },
  );

  app.delete(
    '/api/v2/connection-profiles/:id',
    { schema: { params: profileParams, response: { 200: AckSchema } } },
    async (req) => {
      await repo.delete(req.params.id);
      return { ok: true };
    },
  );

  app.post(
    '/api/v2/connection-profiles/:id/apply',
    { schema: { params: profileParams, response: { 200: ConnectionProfileApplyResultSchema } } },
    async (req) => applyConnectionProfile(ctx, req.params.id),
  );
}

async function applyConnectionProfile(
  ctx: AppContext,
  profileId: string,
): Promise<{
  activeProviderConfigId: string | null;
  activeGenerationPresetId: string | null;
  appliedFields: ConnectionProfileField[];
  excludedFields: ConnectionProfileField[];
}> {
  const profile = requireProfile(
    await ctx.database.repos.connectionProfiles.getFullById(profileId),
    profileId,
  );
  const excluded = new Set(profile.exclude);
  const has = (field: (typeof ConnectionProfileFields)[number]): boolean =>
    !excluded.has(field) && Object.prototype.hasOwnProperty.call(profile, field);
  const appSettings = await ctx.database.repos.settings.getAll();
  const targetId =
    (has('providerConfigId') ? profile.providerConfigId : undefined) ??
    appSettings.activeProviderConfigId;
  if (!targetId) {
    throw new AppError({
      code: ErrorCodes.CONNECTION_PROFILE_TARGET_REQUIRED,
      params: { profileId },
    });
  }
  const provider = await ctx.database.repos.providerConfigs.getFullConfig(targetId);
  if (!provider) {
    throw new AppError({
      code: ErrorCodes.PROVIDER_NOT_FOUND,
      params: { providerConfigId: targetId },
    });
  }
  const providerAdapter = ctx.providers.create(provider.kind, {
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey: provider.apiKey,
    settings: provider.settings,
    timeouts: ctx.config.providerTimeouts,
  });
  const providerMode = providerAdapter.capabilities?.textCompletion ? 'text' : 'chat';
  if (profile.mode !== providerMode) {
    throw new AppError({
      code: ErrorCodes.CONNECTION_PROFILE_MODE_MISMATCH,
      params: { profileId, mode: profile.mode, providerKind: provider.kind },
    });
  }
  const source = provider.settings['source'];
  if (has('source') && profile.source !== source) {
    throw new AppError({
      code: ErrorCodes.CONNECTION_PROFILE_SOURCE_MISMATCH,
      params: { profileId, source: profile.source, providerSource: source },
    });
  }
  if (has('startReplyWith') && !providerAdapter.capabilities?.assistantPrefill) {
    throw new AppError({
      code: ErrorCodes.CONNECTION_PROFILE_PREFILL_UNSUPPORTED,
      params: { profileId, providerKind: provider.kind },
    });
  }

  let presetData: Record<string, unknown> | null = null;
  const presetId = has('presetId') ? profile.presetId : undefined;
  if (presetId !== undefined && presetId !== null) {
    const preset = await ctx.database.repos.presets.getById(presetId);
    if (!preset || preset.kind !== 'generation') {
      throw new AppError({
        code: ErrorCodes.PRESET_NOT_FOUND,
        params: { presetId, kind: 'generation' },
      });
    }
    presetData = isRecord(preset.data) ? preset.data : null;
  }
  const secretId = has('secretId') ? profile.secretId : undefined;
  let selectedSecretValue: string | undefined;
  if (secretId !== undefined) {
    const secret = await ctx.database.repos.providerSecrets.getFullById(targetId, secretId);
    if (!secret) {
      throw new AppError({
        code: ErrorCodes.CONNECTION_PROFILE_SECRET_INVALID,
        params: { profileId, secretId, providerConfigId: targetId },
      });
    }
    const ref = secret.valueRef ?? secret.value;
    const value = ref ? await ctx.secrets.resolve(ref) : null;
    if (value === null || value.length === 0) {
      throw new AppError({
        code: ErrorCodes.CONNECTION_PROFILE_SECRET_INVALID,
        params: { profileId, secretId, providerConfigId: targetId },
      });
    }
    selectedSecretValue = value;
  }

  const providerSettings = { ...provider.settings };
  if (has('promptPostProcessing'))
    providerSettings['promptPostProcessing'] = profile.promptPostProcessing;
  if (has('includeBody')) providerSettings['customIncludeBody'] = profile.includeBody;
  if (has('excludeBody')) providerSettings['customExcludeBody'] = profile.excludeBody;
  if (has('includeHeaders')) providerSettings['customIncludeHeaders'] = profile.includeHeaders;
  if (has('stopStrings')) providerSettings['connectionStopStrings'] = profile.stopStrings;
  if (has('startReplyWith')) providerSettings['assistantPrefill'] = profile.startReplyWith;
  const issues = additionalParamIssues(providerSettings);
  if (issues.length > 0) {
    throw new AppError({
      code: ErrorCodes.PROVIDER_CONFIG_INVALID,
      params: { providerConfigId: targetId, issues },
    });
  }

  const settingsPatch: Record<string, unknown> = {};
  if (has('providerConfigId')) settingsPatch['activeProviderConfigId'] = targetId;
  if (has('presetId')) {
    settingsPatch['activeGenerationPresetId'] = profile.presetId;
    if (presetData) {
      if (typeof presetData['maxContextTokens'] === 'number') {
        settingsPatch['maxContextTokens'] = presetData['maxContextTokens'];
      }
      if (isRecord(presetData['generationDefaults'])) {
        settingsPatch['generationDefaults'] = presetData['generationDefaults'];
      }
    }
  }
  const nextConfig = await assertProviderConfigValid(
    ctx,
    provider.kind,
    {
      baseUrl: has('baseUrl') ? (profile.baseUrl ?? null) : provider.baseUrl,
      model: has('model') ? (profile.model ?? null) : provider.model,
      apiKey: selectedSecretValue ?? provider.apiKey,
      settings: providerSettings,
    },
    { allowMissingApiKey: true },
  );
  const hasActivePresetPatch = Object.prototype.hasOwnProperty.call(
    settingsPatch,
    'activeGenerationPresetId',
  );
  const now = Date.now();

  ctx.database.sqlite.transaction(() => {
    ctx.database.sqlite
      .prepare(
        `UPDATE provider_configs
         SET base_url = ?, model = ?, settings = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextConfig.baseUrl ?? null,
        nextConfig.model ?? null,
        JSON.stringify(nextConfig.settings),
        now,
        targetId,
      );
    if (has('secretId')) {
      ctx.database.sqlite
        .prepare('UPDATE provider_secrets SET active = 0 WHERE provider_id = ?')
        .run(targetId);
      ctx.database.sqlite
        .prepare('UPDATE provider_secrets SET active = 1 WHERE id = ? AND provider_id = ?')
        .run(secretId, targetId);
    }
    const upsert = ctx.database.sqlite.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    for (const [key, value] of Object.entries(settingsPatch)) {
      upsert.run(key, JSON.stringify(value));
    }
  })();

  const appliedFields: ConnectionProfileField[] = ConnectionProfileFields.filter(
    (field): field is ConnectionProfileField => has(field) && field !== 'source',
  );
  return {
    activeProviderConfigId:
      (settingsPatch['activeProviderConfigId'] as string | undefined) ??
      appSettings.activeProviderConfigId,
    activeGenerationPresetId: hasActivePresetPatch
      ? (settingsPatch['activeGenerationPresetId'] as string | null)
      : appSettings.activeGenerationPresetId,
    appliedFields,
    excludedFields: ConnectionProfileFields.filter((field): field is ConnectionProfileField =>
      excluded.has(field),
    ),
  };
}

function requireProfile(profile: ConnectionProfile | null, profileId: string): ConnectionProfile {
  if (profile) return profile;
  throw new AppError({ code: ErrorCodes.CONNECTION_PROFILE_NOT_FOUND, params: { profileId } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
