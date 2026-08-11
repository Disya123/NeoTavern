/**
 * Rev4 kernel: auth.* host handlers for web sandboxes (contract §2, rev4
 * §K5). Thin capability-checked wrappers over the server-side OAuth routes;
 * the server holds the tokens, the sandbox only ever sees metadata.
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failParams(reason: string, extra?: Record<string, unknown>): KernelError {
  return new KernelError(KernelErrorCode.VALIDATION_FAILED, { details: { reason, ...extra } });
}

function denied(ctx: KernelHostContext, capability: string): KernelError {
  return new KernelError(KernelErrorCode.CAPABILITY_DENIED, { details: { capability } });
}

/** Map an auth REST failure onto a stable kernel error code. */
function mapRestError(status: number, body: unknown): KernelError {
  const code = isPlainRecord(body) && typeof body['code'] === 'string' ? body['code'] : '';
  if (status === 403 || code === 'PLUGIN_PERMISSION_DENIED') {
    return new KernelError(KernelErrorCode.CAPABILITY_DENIED, { details: { status, code } });
  }
  if (status === 404 || code === 'PLUGIN_NOT_FOUND') {
    return new KernelError(KernelErrorCode.NOT_FOUND, { details: { status, code } });
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 422 ||
    code === 'VALIDATION_FAILED' ||
    code === 'BAD_REQUEST' ||
    code === 'PLUGIN_INVALID'
  ) {
    return new KernelError(KernelErrorCode.VALIDATION_FAILED, { details: { status, code } });
  }
  return new KernelError(KernelErrorCode.INTERNAL, { details: { status, code } });
}

async function authRest(
  ctx: KernelHostContext,
  path: string,
  init?: { method: string; body?: string },
): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/v2/plugins/${encodeURIComponent(ctx.pluginId)}/auth${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init?.body === undefined ? {} : { body: init.body }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw mapRestError(response.status, body);
  return isPlainRecord(body) ? body : {};
}

export function attachAuth(ctx: KernelHostContext): void {
  const { session } = ctx;
  const requireAuthCapability = (): void => {
    if (!ctx.hasCapability('auth.connections')) throw denied(ctx, 'auth.connections');
  };

  session.handle('auth.list', async () => {
    requireAuthCapability();
    const result = await authRest(ctx, '/connections');
    const items = result['items'];
    if (!Array.isArray(items)) throw failParams('invalid-response');
    return { connections: items };
  });

  session.handle('auth.get', async (request) => {
    requireAuthCapability();
    const params = request.params;
    if (!isPlainRecord(params) || typeof params['connectionId'] !== 'string') {
      throw failParams('connectionId-required');
    }
    const items = await authRest(ctx, '/connections');
    if (!Array.isArray(items['items'])) throw failParams('invalid-response');
    const found = items['items'].find(
      (item) => isPlainRecord(item) && item['connectionId'] === params['connectionId'],
    );
    return { connection: found ?? null };
  });

  session.handle('auth.connect', async (request) => {
    requireAuthCapability();
    const params = request.params;
    if (!isPlainRecord(params) || typeof params['serviceId'] !== 'string') {
      throw failParams('serviceId-required');
    }
    const scopes = params['scopes'];
    if (
      scopes !== undefined &&
      (!Array.isArray(scopes) || scopes.some((s) => typeof s !== 'string'))
    ) {
      throw failParams('scopes-invalid');
    }
    const result = await authRest(ctx, '/connect', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: params['serviceId'],
        ...(scopes === undefined ? {} : { scopes }),
      }),
    });
    if (
      typeof result['connectionId'] !== 'string' ||
      (result['status'] !== 'pending' && result['status'] !== 'connected')
    ) {
      throw failParams('invalid-response');
    }
    return result;
  });

  session.handle('auth.revoke', async (request) => {
    requireAuthCapability();
    const params = request.params;
    if (!isPlainRecord(params) || typeof params['connectionId'] !== 'string') {
      throw failParams('connectionId-required');
    }
    await authRest(ctx, '/revoke', {
      method: 'POST',
      body: JSON.stringify({ connectionId: params['connectionId'] }),
    });
    return { ok: true };
  });
}
