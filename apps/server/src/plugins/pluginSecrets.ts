/**
 * Plugin SecretStore routes (ТЗ §54, §SEC-01): /api/v2/plugins/:id/secrets.
 *
 * Secret values are write-only and never enter the database: the value is
 * stored in the SecretStore and the DB row keeps an opaque reference. The
 * list response masks references; the plaintext is returned only by
 * `/reveal`, and only when secrets exposure is enabled server-side
 * (`NEOTA_ALLOW_SECRETS_EXPOSURE`, default off) — mirrors the provider
 * secrets pattern (AGENTS.md §4, §11). Secrets never enter plugin state,
 * namespaced backup/export sections, logs or diagnostics.
 *
 * Capability mapping: management (PUT/GET/DELETE) requires `secrets.manageOwn`
 * (the plugin manages its own store); reading a plaintext additionally
 * requires `secrets.reveal` on top of the host exposure gate.
 */
import { Type } from '@sinclair/typebox';
import { maskSecretValue } from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import type { PluginSecretScope } from '@neotavern/db';
import type { CapabilityBroker } from '../plugin/capabilityBroker.js';
import { toSecretStoreAppError } from '../lib/secretStore.js';
import type { AppContext, TypedApp } from '../types.js';

/** Mirrors ProviderSecretCreateSchema's value cap (write-only storage). */
const MAX_SECRET_VALUE_LENGTH = 8192;
const MAX_SECRET_KEY_LENGTH = 200;

const SecretScopeSchema = Type.Union([
  Type.Literal('installation'),
  Type.Literal('user'),
  Type.Literal('workspace'),
  Type.Literal('chat'),
]);

const SecretItemSchema = Type.Object({
  key: Type.String(),
  scope: SecretScopeSchema,
  /** Masked preview for display; never the full value. */
  masked: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});

export async function registerPluginSecretRoutes(
  app: TypedApp,
  ctx: AppContext,
  broker: CapabilityBroker,
): Promise<void> {
  const plugins = ctx.database.repos.plugins;
  const secrets = ctx.database.repos.pluginSecrets;

  function requireCapability(pluginId: string, capability: string): void {
    if (!plugins.getById(pluginId)) {
      throw new AppError({ code: ErrorCodes.PLUGIN_NOT_FOUND, params: { pluginId } });
    }
    if (!broker.check(pluginId, { name: capability })) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
        params: { pluginId, capability },
      });
    }
  }

  const params = Type.Object({ id: Type.String() });
  const keyParams = Type.Object({
    id: Type.String(),
    key: Type.String({ minLength: 1, maxLength: MAX_SECRET_KEY_LENGTH }),
  });
  const scopeQuery = Type.Object({ scope: SecretScopeSchema });

  app.put(
    '/api/v2/plugins/:id/secrets',
    {
      schema: {
        params,
        querystring: scopeQuery,
        body: Type.Object({
          key: Type.String({ minLength: 1, maxLength: MAX_SECRET_KEY_LENGTH }),
          value: Type.String({ maxLength: MAX_SECRET_VALUE_LENGTH }),
        }),
        response: { 200: Type.Object({ ok: Type.Boolean() }) },
      },
    },
    async (request) => {
      requireCapability(request.params.id, 'secrets.manageOwn');
      const scope = request.query.scope as PluginSecretScope;
      // Write-only: the value goes to the SecretStore, the DB keeps only an
      // opaque reference, and the value is never echoed in any response.
      let ref: string;
      try {
        ref = await ctx.secrets.storeValue(
          `plugin:${request.params.id}`,
          ctx.secrets.pluginSecretId(scope, request.body.key),
          request.body.value,
        );
      } catch (error) {
        const mapped = toSecretStoreAppError(error);
        if (mapped) throw mapped;
        throw error;
      }
      secrets.upsert(request.params.id, scope, request.body.key, ref);
      return { ok: true };
    },
  );

  // List keys + metadata only. The masked preview is display material; the
  // plaintext is reachable solely through the gated reveal route.
  app.get(
    '/api/v2/plugins/:id/secrets',
    {
      schema: {
        params,
        response: { 200: Type.Object({ items: Type.Array(SecretItemSchema) }) },
      },
    },
    async (request) => {
      requireCapability(request.params.id, 'secrets.manageOwn');
      const items = secrets.list(request.params.id).map((entry) => ({
        key: entry.key,
        scope: entry.scope,
        masked: maskSecretValue(entry.valueRef ?? entry.value ?? ''),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));
      return { items };
    },
  );

  app.delete(
    '/api/v2/plugins/:id/secrets/:key',
    {
      schema: {
        params: keyParams,
        querystring: scopeQuery,
        response: { 200: Type.Object({ ok: Type.Boolean() }) },
      },
    },
    async (request) => {
      requireCapability(request.params.id, 'secrets.manageOwn');
      const scope = request.query.scope as PluginSecretScope;
      const deleted = secrets.delete(request.params.id, scope, request.params.key);
      if (!deleted) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          params: { pluginId: request.params.id, scope, key: request.params.key },
        });
      }
      // SEC-01: drop the stored value for the deleted reference too, so the
      // store keeps no orphaned plugin secrets (no-op on env/read-only).
      const id = ctx.secrets.pluginSecretId(scope, request.params.key);
      await ctx.secrets.deleteValue(`plugin:${request.params.id}`, id);
      return { ok: true };
    },
  );

  // Plaintext is returned only when secrets exposure is enabled server-side,
  // and only with the dedicated `secrets.reveal` grant (mirrors the provider
  // `/reveal` pattern exactly).
  app.post(
    '/api/v2/plugins/:id/secrets/:key/reveal',
    {
      schema: {
        params: keyParams,
        querystring: scopeQuery,
        response: { 200: Type.Object({ value: Type.String() }) },
      },
    },
    async (request) => {
      requireCapability(request.params.id, 'secrets.reveal');
      if (!ctx.config.allowSecretsExposure) {
        throw new AppError({
          code: ErrorCodes.SECRETS_EXPOSURE_DISABLED,
          message: 'Secret reveal is disabled. Set NEOTA_ALLOW_SECRETS_EXPOSURE=true to enable it.',
        });
      }
      const scope = request.query.scope as PluginSecretScope;
      const entry = secrets.get(request.params.id, scope, request.params.key);
      if (!entry) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          params: { pluginId: request.params.id, scope, key: request.params.key },
        });
      }
      const ref = entry.valueRef ?? entry.value;
      const value = ref ? await ctx.secrets.resolve(ref) : null;
      if (value === null) {
        throw new AppError({
          code: ErrorCodes.SECRET_UNAVAILABLE_ON_THIS_DEVICE,
          params: { pluginId: request.params.id, scope, key: request.params.key },
        });
      }
      return { value };
    },
  );
}
