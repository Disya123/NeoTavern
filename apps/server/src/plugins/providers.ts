/** Provider config routes: /api/v2/providers. Secrets are never returned. */
import {
  IdSchema,
  AckSchema,
  additionalParamIssues,
  BuiltinProviderKinds,
  ImageRequestSchema,
  ImageResultSchema,
  PromptPostProcessingModes,
  ProviderCatalogResponseSchema,
  ModelInfoSchema,
  ProviderConfigCreateSchema,
  ProviderConfigSchema,
  ProviderConfigUpdateSchema,
  ProviderTestRequestSchema,
  ProviderTestResponseSchema,
  SpeechRequestSchema,
  SpeechResultSchema,
  TranscriptionRequestSchema,
  TranscriptionResultSchema,
  type ModelInfo,
} from '@neotavern/contracts';
import { AppError, ErrorCodes, LruCache } from '@neotavern/shared';
import {
  PROVIDER_CATALOG,
  findProviderCatalogEntry,
  type ProviderAdapter,
  type ProviderRegistry,
  type ProviderRuntimeConfig,
  type ProviderTimeouts,
} from '@neotavern/provider-sdk';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import type { AppContext, TypedApp } from '../types.js';

const PROVIDER_CATALOG_RESPONSE = { items: [...PROVIDER_CATALOG] };
type PersistedRuntimeConfig = Omit<ProviderRuntimeConfig, 'fetchImpl' | 'timeouts' | 'logger'>;

/** Narrow context surface used by config validation (satisfied by AppContext). */
export interface ProviderConfigValidationContext {
  providers: ProviderRegistry;
  config: { providerTimeouts: ProviderTimeouts };
}

interface ConfigIssue {
  path: string;
  message: string;
}

/**
 * Validate the SillyTavern-style "Additional Parameters" and prompt
 * post-processing settings that live on a provider config's `settings`. These
 * are stored as structured JSON (not YAML); shapes are enforced here so a
 * malformed value fails at write time, not at generation time. Custom
 * parameter rules come from the shared {@link additionalParamIssues} contract
 * so server and web editor can never drift; only the server-owned
 * post-processing enum is checked locally.
 */
function settingsIssues(settings: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = [...additionalParamIssues(settings)];
  const postProcessing = settings['promptPostProcessing'];
  if (
    postProcessing !== undefined &&
    !PromptPostProcessingModes.includes(
      postProcessing as (typeof PromptPostProcessingModes)[number],
    )
  ) {
    issues.push({ path: 'settings.promptPostProcessing', message: 'unknown post-processing mode' });
  }
  return issues;
}

/** Apply catalog defaults and enforce built-in source invariants. */
function normalizeCatalogConfig(
  kind: string,
  config: PersistedRuntimeConfig,
  options: { allowMissingApiKey?: boolean } = {},
): PersistedRuntimeConfig {
  const settings = { ...config.settings };
  if (kind === 'anthropic' && settings['source'] === undefined) {
    settings['source'] = 'anthropic';
  }
  const paramIssues = settingsIssues(settings);
  if (paramIssues.length > 0) {
    throw new AppError({
      code: ErrorCodes.PROVIDER_CONFIG_INVALID,
      params: { kind, issues: paramIssues },
      message: 'Additional parameters are invalid',
    });
  }
  const source = settings['source'];
  const catalogEntry = findProviderCatalogEntry(source);
  const isBuiltinKind = (BuiltinProviderKinds as readonly string[]).includes(kind);
  if (source !== undefined && !catalogEntry && isBuiltinKind && kind !== 'echo') {
    throw new AppError({
      code: ErrorCodes.PROVIDER_CONFIG_INVALID,
      params: {
        kind,
        issues: [{ path: 'settings.source', message: 'unknown provider source' }],
      },
      message: 'Provider source is not in the built-in catalog',
    });
  }
  if (!catalogEntry) return { ...config, settings };
  if (catalogEntry.adapterKind !== kind) {
    throw new AppError({
      code: ErrorCodes.PROVIDER_CONFIG_INVALID,
      params: {
        kind,
        issues: [
          {
            path: 'kind',
            message: `source ${catalogEntry.id} requires ${catalogEntry.adapterKind}`,
          },
        ],
      },
      message: 'Provider kind does not match its catalog source',
    });
  }
  if (
    catalogEntry.apiKeyRequired &&
    !options.allowMissingApiKey &&
    (!config.apiKey || config.apiKey.trim().length === 0)
  ) {
    throw new AppError({
      code: ErrorCodes.PROVIDER_CONFIG_INVALID,
      params: {
        kind,
        issues: [{ path: 'apiKey', message: 'apiKey is required' }],
      },
      message: 'This provider source requires an API key',
    });
  }
  if (catalogEntry.id === 'openai-compatible') {
    const compatibility = settings['samplerCompatibility'];
    if (compatibility === undefined) {
      settings['samplerCompatibility'] = 'standard';
    } else if (compatibility !== 'standard' && compatibility !== 'extended') {
      throw new AppError({
        code: ErrorCodes.PROVIDER_CONFIG_INVALID,
        params: {
          kind,
          issues: [
            {
              path: 'settings.samplerCompatibility',
              message: 'must be standard or extended',
            },
          ],
        },
        message: 'Custom sampler compatibility is invalid',
      });
    }
  }
  const configuredBaseUrl = config.baseUrl?.trim() ? config.baseUrl : null;
  return {
    ...config,
    settings,
    baseUrl: catalogEntry.baseUrlEditable
      ? (configuredBaseUrl ?? catalogEntry.defaultBaseUrl)
      : null,
  };
}

/**
 * Run catalog and adapter validation before a provider configuration is stored
 * or used.
 */
export async function assertProviderConfigValid(
  ctx: ProviderConfigValidationContext,
  kind: string,
  config: Omit<ProviderRuntimeConfig, 'fetchImpl' | 'timeouts' | 'logger'>,
  options: { allowMissingApiKey?: boolean } = {},
): Promise<PersistedRuntimeConfig> {
  const normalized = normalizeCatalogConfig(kind, config, options);
  const adapter = ctx.providers.create(kind, {
    ...normalized,
    timeouts: ctx.config.providerTimeouts,
  });
  const result = await adapter.validateConfig();
  if (!result.valid) {
    throw new AppError({
      code: ErrorCodes.PROVIDER_CONFIG_INVALID,
      params: { kind, issues: result.issues },
      message: `Provider configuration is invalid: ${result.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    });
  }
  return normalized;
}

export async function registerProviderRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.providerConfigs;
  // Bounded model-list cache (ТЗ §11.2): keyed by config revision, so editing
  // a provider implicitly invalidates; TTL covers server-side model changes.
  const modelCache = new LruCache<ModelInfo[]>({ maxSize: 32, ttlMs: 60_000 });

  app.get(
    '/api/v2/providers/catalog',
    { schema: { response: { 200: ProviderCatalogResponseSchema } } },
    async () => PROVIDER_CATALOG_RESPONSE,
  );

  app.get(
    '/api/v2/providers',
    { schema: { response: { 200: Type.Object({ items: Type.Array(ProviderConfigSchema) }) } } },
    async () => ({ items: await repo.list() }),
  );

  app.post(
    '/api/v2/providers',
    { schema: { body: ProviderConfigCreateSchema, response: { 200: ProviderConfigSchema } } },
    async (req) => {
      const normalized = await assertProviderConfigValid(
        ctx,
        req.body.kind,
        {
          baseUrl: req.body.baseUrl ?? null,
          model: req.body.model ?? null,
          apiKey: req.body.apiKey ?? null,
          settings: req.body.settings ?? {},
        },
        { allowMissingApiKey: true },
      );
      return repo.create({
        ...req.body,
        baseUrl: normalized.baseUrl,
        settings: normalized.settings,
      });
    },
  );

  app.patch(
    '/api/v2/providers/:id',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: ProviderConfigUpdateSchema,
        response: { 200: ProviderConfigSchema },
      },
    },
    async (req) => {
      // Validate the merged result before persisting, so a bad patch never
      // lands (and cannot wedge generation later).
      const existing = await repo.getFullConfig(req.params.id);
      if (!existing)
        throw new AppError({
          code: ErrorCodes.PROVIDER_NOT_FOUND,
          params: { kind: req.params.id },
        });
      const kind = req.body.kind ?? existing.kind;
      const normalized = await assertProviderConfigValid(ctx, kind, {
        baseUrl: req.body.baseUrl !== undefined ? req.body.baseUrl : existing.baseUrl,
        model: req.body.model !== undefined ? req.body.model : existing.model,
        apiKey: req.body.apiKey !== undefined ? req.body.apiKey : existing.apiKey,
        settings: { ...existing.settings, ...req.body.settings },
      });
      const updated = await repo.update(req.params.id, {
        ...req.body,
        kind,
        baseUrl: normalized.baseUrl,
        model: normalized.model,
        settings: normalized.settings,
      });
      if (!updated)
        throw new AppError({
          code: ErrorCodes.PROVIDER_NOT_FOUND,
          params: { kind: req.params.id },
        });
      return updated;
    },
  );

  app.delete(
    '/api/v2/providers/:id',
    {
      schema: { params: Type.Object({ id: IdSchema }), response: { 200: AckSchema } },
    },
    async (req) => {
      await repo.delete(req.params.id);
      return { ok: true };
    },
  );

  // List models for a configured provider (validates connectivity).
  app.get(
    '/api/v2/providers/:id/models',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: Type.Object({ models: Type.Array(ModelInfoSchema) }) },
      },
    },
    async (req) => {
      const full = await repo.getFullConfig(req.params.id);
      if (!full)
        throw new AppError({
          code: ErrorCodes.PROVIDER_NOT_FOUND,
          params: { kind: req.params.id },
        });
      const normalized = await assertProviderConfigValid(ctx, full.kind, {
        baseUrl: full.baseUrl,
        model: full.model,
        apiKey: full.apiKey,
        settings: full.settings,
      });
      const adapter = ctx.providers.create(full.kind, {
        baseUrl: normalized.baseUrl,
        model: normalized.model,
        apiKey: normalized.apiKey,
        settings: normalized.settings,
        timeouts: ctx.config.providerTimeouts,
      });
      const models = await modelCache.getOrComputeAsync(`${full.id}:${full.updatedAt}`, () =>
        adapter.listModels(AbortSignal.timeout(ctx.config.providerTimeouts.readMs)),
      );
      return { models };
    },
  );

  app.post(
    '/api/v2/providers/:id/test',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: ProviderTestRequestSchema,
        response: { 200: ProviderTestResponseSchema },
      },
    },
    async (req) => {
      const full = await repo.getFullConfig(req.params.id);
      if (!full) {
        throw new AppError({
          code: ErrorCodes.PROVIDER_NOT_FOUND,
          params: { kind: req.params.id },
        });
      }
      if (!full.model || full.model.trim().length === 0) {
        throw new AppError({
          code: ErrorCodes.PROVIDER_CONFIG_INVALID,
          params: {
            kind: full.kind,
            issues: [{ path: 'model', message: 'model is required' }],
          },
          message: 'A model is required before testing a provider',
        });
      }
      const normalized = await assertProviderConfigValid(ctx, full.kind, {
        baseUrl: full.baseUrl,
        model: full.model,
        apiKey: full.apiKey,
        settings: full.settings,
      });
      const adapter = ctx.providers.create(full.kind, {
        baseUrl: normalized.baseUrl,
        model: normalized.model,
        apiKey: normalized.apiKey,
        settings: normalized.settings,
        timeouts: ctx.config.providerTimeouts,
      });

      const disconnect = new AbortController();
      const abort = (): void => disconnect.abort();
      req.raw.once('aborted', abort);
      const signal = AbortSignal.any([
        disconnect.signal,
        AbortSignal.timeout(ctx.config.providerTimeouts.readMs * 4),
      ]);
      try {
        for await (const event of adapter.generate(
          {
            model: full.model,
            messages: [{ role: 'user', content: req.body.message }],
            maxTokens: 128,
            temperature: 1,
            stream: false,
          },
          signal,
        )) {
          if (event.type === 'done') {
            return {
              text: event.text,
              ...(event.usage ? { usage: event.usage } : {}),
            };
          }
          if (event.type === 'error') {
            throw new AppError({ code: event.code as never, message: event.message });
          }
        }
        throw new AppError({
          code: ErrorCodes.GENERATION_FAILED,
          message: 'Provider test ended without a terminal event',
        });
      } finally {
        req.raw.off('aborted', abort);
      }
    },
  );

  // --- Non-text modalities (ТЗ §4.3: TTS / image / STT share the adapter
  // contract). Streaming events are collected server-side into one result. ---

  app.post(
    '/api/v2/providers/:id/speech',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: SpeechRequestSchema,
        response: { 200: SpeechResultSchema },
      },
    },
    async (req, reply) => {
      const adapter = await adapterForRequest(ctx, req.params.id);
      if (!adapter.speech) throw modalityUnsupported(adapter.kind, 'speech');
      const chunks: string[] = [];
      let mime = 'application/octet-stream';
      let bytes = 0;
      for await (const event of adapter.speech(req.body, signalFor(ctx, reply))) {
        if (event.type === 'audio') {
          chunks.push(event.dataBase64);
          mime = event.mime;
        } else if (event.type === 'done') {
          bytes = event.bytes;
          mime = event.mime;
        } else if (event.type === 'error') {
          throw new AppError({ code: event.code as never, message: event.message });
        }
      }
      return { dataBase64: chunks.join(''), mime, bytes };
    },
  );

  app.post(
    '/api/v2/providers/:id/images',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: ImageRequestSchema,
        response: { 200: ImageResultSchema },
      },
    },
    async (req, reply) => {
      const adapter = await adapterForRequest(ctx, req.params.id);
      if (!adapter.image) throw modalityUnsupported(adapter.kind, 'image');
      const images: Array<{ dataBase64: string; mime: string }> = [];
      for await (const event of adapter.image(req.body, signalFor(ctx, reply))) {
        if (event.type === 'image') {
          images.push({ dataBase64: event.dataBase64, mime: event.mime });
        } else if (event.type === 'error') {
          throw new AppError({ code: event.code as never, message: event.message });
        }
      }
      return { images };
    },
  );

  app.post(
    '/api/v2/providers/:id/transcribe',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: TranscriptionRequestSchema,
        response: { 200: TranscriptionResultSchema },
      },
    },
    async (req, reply) => {
      const adapter = await adapterForRequest(ctx, req.params.id);
      if (!adapter.transcribe) throw modalityUnsupported(adapter.kind, 'transcription');
      return adapter.transcribe(req.body, signalFor(ctx, reply));
    },
  );
}

/** Resolve a validated adapter for a configured provider (modality routes). */
async function adapterForRequest(ctx: AppContext, id: string): Promise<ProviderAdapter> {
  const full = await ctx.database.repos.providerConfigs.getFullConfig(id);
  if (!full) {
    throw new AppError({ code: ErrorCodes.PROVIDER_NOT_FOUND, params: { kind: id } });
  }
  const normalized = await assertProviderConfigValid(ctx, full.kind, {
    baseUrl: full.baseUrl,
    model: full.model,
    apiKey: full.apiKey,
    settings: full.settings,
  });
  const adapter = ctx.providers.create(full.kind, {
    ...normalized,
    timeouts: ctx.config.providerTimeouts,
  });
  return adapter;
}

function signalFor(ctx: AppContext, reply: FastifyReply): AbortSignal {
  // Timeout AND client disconnect: a closed connection used to leave the
  // adapter call running until the timeout expired (PROV-33 L3).
  const disconnect = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) disconnect.abort();
  });
  return AbortSignal.any([
    AbortSignal.timeout(ctx.config.providerTimeouts.readMs * 4),
    disconnect.signal,
  ]);
}

function modalityUnsupported(kind: string, modality: string): AppError {
  return new AppError({
    code: ErrorCodes.BAD_REQUEST,
    params: { kind, modality, reason: 'MODALITY_NOT_SUPPORTED' },
    message: `Provider kind "${kind}" does not support ${modality}`,
  });
}
