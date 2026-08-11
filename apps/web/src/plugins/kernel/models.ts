/**
 * Rev4 kernel: models.list host handler (contract §2 models).
 *
 * Lists the models of a provider config through the server REST route
 * `GET /api/v2/providers/:id/models`. `providerId` is optional — when
 * omitted the host answers for the active provider config (the app reports
 * it via `FrontendPluginRuntime.setActiveProviderConfigId`), which lets a
 * plugin open the model menu without knowing the current provider id.
 */
import { MODELS_MAX_LIST } from '@neotavern/contracts';
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

/** Max accepted providerId length (ids are UUIDv7 or short slugs). */
const MAX_PROVIDER_ID_LENGTH = 128;

function fail(code: string, details?: Record<string, unknown>): KernelError {
  return new KernelError(code, { details });
}

function requireCapability(ctx: KernelHostContext, name: string): void {
  if (!ctx.hasCapability(name)) {
    throw fail(KernelErrorCode.CAPABILITY_DENIED, { capability: name });
  }
}

/** Map the server error envelope onto kernel wire codes. */
function kernelErrorFromStatus(status: number, code: string, params: unknown): KernelError {
  const details = { httpStatus: status, code, params };
  switch (code) {
    case 'PROVIDER_NOT_FOUND':
    case 'NOT_FOUND':
      return fail(KernelErrorCode.NOT_FOUND, details);
    case 'PLUGIN_PERMISSION_DENIED':
    case 'FORBIDDEN':
      return fail(KernelErrorCode.CAPABILITY_DENIED, details);
    case 'VALIDATION':
    case 'BAD_REQUEST':
      return fail(KernelErrorCode.VALIDATION_FAILED, details);
    default:
      return fail(KernelErrorCode.INTERNAL, details);
  }
}

async function parseError(res: Response): Promise<KernelError> {
  let code = 'INTERNAL';
  let params: unknown = null;
  try {
    const body = (await res.json()) as { code?: unknown; params?: unknown };
    if (typeof body.code === 'string') code = body.code;
    params = body.params ?? null;
  } catch {
    // Non-JSON error body: fall back to the status alone.
  }
  return kernelErrorFromStatus(res.status, code, params);
}

export function attachModels(ctx: KernelHostContext): void {
  ctx.session.handle('models.list', async (request) => {
    const params = request.params as Record<string, unknown>;
    const rawProviderId = params.providerId;
    if (rawProviderId !== undefined) {
      if (typeof rawProviderId !== 'string' || rawProviderId.length > MAX_PROVIDER_ID_LENGTH) {
        throw fail(KernelErrorCode.VALIDATION_FAILED, { field: 'providerId' });
      }
    }
    requireCapability(ctx, 'models.list');
    const providerId =
      typeof rawProviderId === 'string' && rawProviderId.trim().length > 0
        ? rawProviderId.trim()
        : ctx.currentProviderId();
    if (!providerId) {
      throw fail(KernelErrorCode.NOT_FOUND, { providerId: null });
    }
    const res = await fetch(`/api/v2/providers/${encodeURIComponent(providerId)}/models`);
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) {
      throw fail(KernelErrorCode.PROTOCOL_INVALID, { method: 'models.list' });
    }
    return { models: body.models.slice(0, MODELS_MAX_LIST) };
  });
}
