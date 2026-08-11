/**
 * Provider secret routes: /api/v2/providers/:id/secrets (+ /api/v2/secrets/exposure).
 *
 * Secret values are write-only. List responses are masked; the plaintext is
 * returned only by `/reveal`, and only when secrets exposure is enabled
 * server-side (`NEOTA_ALLOW_SECRETS_EXPOSURE`, default off). Mirrors SillyTavern's
 * `allowKeysExposure` gate (AGENTS.md §4, §11).
 */
import {
  IdSchema,
  AckSchema,
  ProviderSecretCreateSchema,
  ProviderSecretCreatedSchema,
  ProviderSecretListSchema,
  ProviderSecretRevealSchema,
  ProviderSecretSchema,
  ProviderSecretUpdateSchema,
  SecretsExposureSchema,
} from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { AppContext, TypedApp } from '../types.js';

const providerParams = Type.Object({ id: IdSchema });
const secretParams = Type.Object({ id: IdSchema, secretId: Type.String() });

export async function registerSecretRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const providers = ctx.database.repos.providerConfigs;
  const secrets = ctx.database.repos.providerSecrets;

  /** 404 unless the owning provider exists. */
  async function assertProvider(id: string): Promise<void> {
    const provider = await providers.getById(id);
    if (!provider) {
      throw new AppError({ code: ErrorCodes.PROVIDER_NOT_FOUND, params: { kind: id } });
    }
  }

  app.get(
    '/api/v2/secrets/exposure',
    { schema: { response: { 200: SecretsExposureSchema } } },
    async () => ({ allowSecretsExposure: ctx.config.allowSecretsExposure }),
  );

  app.get(
    '/api/v2/providers/:id/secrets',
    {
      schema: { params: providerParams, response: { 200: ProviderSecretListSchema } },
    },
    async (req) => {
      await assertProvider(req.params.id);
      return { items: await secrets.listByProvider(req.params.id) };
    },
  );

  app.post(
    '/api/v2/providers/:id/secrets',
    {
      schema: {
        params: providerParams,
        body: ProviderSecretCreateSchema,
        response: { 200: ProviderSecretCreatedSchema },
      },
    },
    async (req) => {
      await assertProvider(req.params.id);
      const id = await secrets.create(
        req.params.id,
        req.body.value,
        req.body.label?.trim() ? req.body.label.trim() : null,
      );
      return { id };
    },
  );

  app.patch(
    '/api/v2/providers/:id/secrets/:secretId',
    {
      schema: {
        params: secretParams,
        body: ProviderSecretUpdateSchema,
        response: { 200: ProviderSecretSchema },
      },
    },
    async (req) => {
      const updated = await secrets.update(req.params.id, req.params.secretId, {
        label: req.body.label,
        active: req.body.active,
      });
      if (!updated) {
        throw new AppError({
          code: ErrorCodes.PROVIDER_SECRET_NOT_FOUND,
          params: { secretId: req.params.secretId },
        });
      }
      return updated;
    },
  );

  app.delete(
    '/api/v2/providers/:id/secrets/:secretId',
    { schema: { params: secretParams, response: { 200: AckSchema } } },
    async (req) => {
      const deleted = await secrets.delete(req.params.id, req.params.secretId);
      if (!deleted) {
        throw new AppError({
          code: ErrorCodes.PROVIDER_SECRET_NOT_FOUND,
          params: { secretId: req.params.secretId },
        });
      }
      return { ok: true };
    },
  );

  app.post(
    '/api/v2/providers/:id/secrets/:secretId/reveal',
    {
      schema: {
        params: secretParams,
        response: { 200: ProviderSecretRevealSchema },
      },
    },
    async (req) => {
      if (!ctx.config.allowSecretsExposure) {
        throw new AppError({
          code: ErrorCodes.SECRETS_EXPOSURE_DISABLED,
          message: 'Secret reveal is disabled. Set NEOTA_ALLOW_SECRETS_EXPOSURE=true to enable it.',
        });
      }
      const full = await secrets.getFullById(req.params.id, req.params.secretId);
      if (!full) {
        throw new AppError({
          code: ErrorCodes.PROVIDER_SECRET_NOT_FOUND,
          params: { secretId: req.params.secretId },
        });
      }
      return { value: full.value };
    },
  );
}
