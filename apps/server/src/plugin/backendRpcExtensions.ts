/**
 * Rev4 §3: kernel-namespaced RPCs contributed to the backend plugin host.
 *
 * `BackendPluginHost.registerExternalRpc` is the dispatch-table extension
 * point; each rev4 slice appends ONE registration call here (contract
 * local://rev4-contract.md §3/§6):
 *   - A1 StorageBlobs: storage.kv.* + storage.blobs.*
 *   - A2 BackendBridge: backend byte-stream plumbing
 *   - A7 JobsIntegrations: jobs.schedule/list/cancel, network.fetch
 *   - K5 OAuthConnections: auth.list/get/connect/revoke, network.fetch
 *     connectionId injection
 *
 * Handlers receive the calling `BackendProcess` (pluginId, permissions) and
 * the raw args object; they MUST enforce capabilities themselves via the
 * broker and throw `AppError` with stable `ErrorCodes`.
 *
 * A7 note: `secrets.resolve` is deliberately NOT registered (contract §2:
 * server-side only, never a plugin-visible RPC). Secret use is folded into
 * `network.fetch`: an `authSecretRef` resolves a provider secret on the
 * server and injects the Authorization header before the host-checked fetch.
 */
import { createHash } from 'node:crypto';
import { AppError, ErrorCodes, randomToken } from '@neotavern/shared';
import { validateManifest } from '@neotavern/plugin-sdk';
import type { AuthConnectionEntry } from '@neotavern/db';
import type { AppContext } from '../types.js';
import type { CapabilityBroker } from './capabilityBroker.js';
import { resolveConnectionAuthorization } from './authConnections.js';
import type { BackendPluginHost, BackendProcess } from './backendHost.js';
import type { PluginJobsManager, JobPublic } from '../plugins/pluginJobs.js';

/** Validated manifest of an installed plugin, or null when missing/broken. */
function manifestOf(ctx: AppContext, pluginId: string) {
  const entry = ctx.database.repos.plugins.getById(pluginId);
  if (!entry) return null;
  const result = validateManifest(entry.manifest);
  return result.ok ? result.value : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireCapability(broker: CapabilityBroker, pluginId: string, name: string): void {
  if (!broker.check(pluginId, { name })) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
      params: { pluginId, permission: name },
    });
  }
}

function toPublic(record: {
  jobId: string;
  name: string;
  runAt?: number;
  intervalMs?: number;
  cron?: string;
  payload?: unknown;
  status?: 'active' | 'failed';
  attempts?: number;
  maxRetries?: number;
  lastError?: string;
  failedAt?: number;
}): JobPublic {
  return {
    jobId: record.jobId,
    name: record.name,
    ...(record.runAt === undefined ? {} : { runAt: record.runAt }),
    ...(record.intervalMs === undefined ? {} : { intervalMs: record.intervalMs }),
    ...(record.cron === undefined ? {} : { cron: record.cron }),
    ...(record.payload === undefined ? {} : { payload: record.payload }),
    status: record.status ?? 'active',
    attempts: record.attempts ?? 0,
    ...(record.maxRetries === undefined ? {} : { maxRetries: record.maxRetries }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    ...(record.failedAt === undefined ? {} : { failedAt: record.failedAt }),
  };
}

function scheduleInput(args: Record<string, unknown>): {
  name: string;
  runAt?: number;
  intervalMs?: number;
  payload?: unknown;
} {
  const name = args['name'];
  if (typeof name !== 'string') {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'JOB_NAME_INVALID' },
    });
  }
  return {
    name,
    ...(typeof args['runAt'] === 'number' ? { runAt: args['runAt'] } : {}),
    ...(typeof args['intervalMs'] === 'number' ? { intervalMs: args['intervalMs'] } : {}),
    ...(args['payload'] === undefined ? {} : { payload: args['payload'] }),
  };
}

/**
 * Resolve `authSecretRef` into an Authorization header value. Accepts a
 * provider id string (uses the provider's active secret) or
 * `{providerId, secretId?}`. Plaintext never leaves this function.
 */
async function resolveAuthorization(
  ctx: AppContext,
  broker: CapabilityBroker,
  pluginId: string,
  ref: unknown,
): Promise<string> {
  requireCapability(broker, pluginId, 'secrets.use');
  let providerId: string | null = null;
  let secretId: string | null = null;
  if (typeof ref === 'string') {
    providerId = ref;
  } else if (isPlainRecord(ref) && typeof ref['providerId'] === 'string') {
    providerId = ref['providerId'];
    if (typeof ref['secretId'] === 'string') secretId = ref['secretId'];
  }
  if (providerId === null || providerId.length === 0 || providerId.length > 200) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'SECRET_REF_INVALID' },
    });
  }
  const secrets = ctx.database.repos.providerSecrets;
  const value =
    secretId !== null
      ? ((await secrets.getFullById(providerId, secretId))?.value ?? null)
      : await secrets.getActiveValue(providerId);
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError({
      code: ErrorCodes.PROVIDER_SECRET_NOT_FOUND,
      params: { providerId },
    });
  }
  return `Bearer ${value}`;
}

/** Registers kernel-namespaced RPCs served for backend plugins (rev4 §3). */
export function registerBackendRpcExtensions(
  host: BackendPluginHost,
  ctx: AppContext,
  broker: CapabilityBroker,
  jobs: PluginJobsManager,
): void {
  host.registerExternalRpc('jobs.schedule', async (process, args) => {
    requireCapability(broker, process.pluginId, 'jobs.background');
    const record = await jobs.schedule({ pluginId: process.pluginId, ...scheduleInput(args) });
    return { jobId: record.jobId };
  });

  host.registerExternalRpc('jobs.list', async (process) => {
    requireCapability(broker, process.pluginId, 'jobs.background');
    const items = (await jobs.list(process.pluginId)).map(toPublic);
    return { items };
  });

  host.registerExternalRpc('jobs.cancel', async (process, args) => {
    requireCapability(broker, process.pluginId, 'jobs.background');
    const jobId = args['jobId'];
    if (typeof jobId !== 'string') {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'JOB_ID_INVALID' },
      });
    }
    await jobs.cancel(process.pluginId, jobId);
    return {};
  });

  /**
   * Host-checked fetch (allowlist lives in `fetchRpc`); `authSecretRef`
   * injects the Authorization header server-side before delegation.
   */
  host.registerExternalRpc('network.fetch', async (process, args) => {
    const headers: Record<string, string> = {};
    const rawHeaders = args['headers'];
    if (isPlainRecord(rawHeaders)) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (typeof value === 'string') headers[key] = value;
      }
    }
    const connectionId = args['connectionId'];
    if (connectionId !== undefined && args['authSecretRef'] !== undefined) {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'AUTH_CONNECTION_AND_SECRET_MUTUALLY_EXCLUSIVE' },
      });
    }
    if (connectionId !== undefined) {
      headers['Authorization'] = await resolveConnectionAuthorization(
        ctx,
        broker,
        process.pluginId,
        connectionId,
      );
    }
    if (args['authSecretRef'] !== undefined) {
      headers['Authorization'] = await resolveAuthorization(
        ctx,
        broker,
        process.pluginId,
        args['authSecretRef'],
      );
    }
    return host.fetchRpc(process, {
      url: args['url'],
      ...(typeof args['method'] === 'string' ? { method: args['method'] } : {}),
      headers,
      ...(typeof args['bodyText'] === 'string' ? { body: args['bodyText'] } : {}),
    });
  });

  const connections = ctx.database.repos.authConnections;

  const authEntry = (process: BackendProcess, connectionId: unknown) => {
    requireCapability(broker, process.pluginId, 'auth.connections');
    if (typeof connectionId !== 'string' || connectionId.length === 0 || connectionId.length > 64) {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'AUTH_CONNECTION_ID_INVALID' },
      });
    }
    const entry = connections.getById(process.pluginId, connectionId);
    if (!entry) {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'AUTH_CONNECTION_NOT_FOUND' },
      });
    }
    return entry;
  };

  const toPublicConnection = (entry: AuthConnectionEntry) => ({
    connectionId: entry.id,
    serviceId: entry.serviceId,
    serviceName: entry.serviceName,
    scopes: entry.scopes,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });

  host.registerExternalRpc('auth.list', async (process) => {
    requireCapability(broker, process.pluginId, 'auth.connections');
    return { connections: connections.list(process.pluginId).map(toPublicConnection) };
  });

  host.registerExternalRpc('auth.get', async (process, args) => {
    requireCapability(broker, process.pluginId, 'auth.connections');
    const entry = authEntry(process, args['connectionId']);
    return { connection: toPublicConnection(entry) };
  });

  host.registerExternalRpc('auth.connect', async (process, args) => {
    requireCapability(broker, process.pluginId, 'auth.connections');
    const serviceId = args['serviceId'];
    if (typeof serviceId !== 'string' || serviceId.length === 0 || serviceId.length > 200) {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'AUTH_SERVICE_ID_INVALID' },
      });
    }
    const scopes = args['scopes'];
    if (
      scopes !== undefined &&
      (!Array.isArray(scopes) || scopes.some((s) => typeof s !== 'string'))
    ) {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'AUTH_SCOPES_INVALID' },
      });
    }
    const manifest = manifestOf(ctx, process.pluginId);
    const client = manifest?.authClients?.find((item) => item.serviceId === serviceId);
    if (!client) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_INVALID,
        params: { reason: 'auth-service-not-declared', serviceId },
      });
    }
    const existing = connections.getActiveByService(process.pluginId, client.serviceId);
    if (existing) {
      return {
        connectionId: existing.id,
        status: existing.status,
        authorizationUrl: null,
      };
    }
    const state = randomToken(32);
    const codeVerifier = randomToken(32);
    const created = connections.createPending({
      pluginId: process.pluginId,
      serviceId: client.serviceId,
      serviceName: client.name,
      scopes: (scopes as string[] | undefined) ?? client.scopes,
      state,
      codeVerifier,
    });
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const url = new URL(client.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set(
      'redirect_uri',
      `${ctx.config.publicOrigin}/api/v2/plugins/${encodeURIComponent(process.pluginId)}/auth/callback`,
    );
    url.searchParams.set('scope', created.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { connectionId: created.id, status: 'pending', authorizationUrl: url.toString() };
  });

  host.registerExternalRpc('auth.revoke', async (process, args) => {
    requireCapability(broker, process.pluginId, 'auth.connections');
    const entry = authEntry(process, args['connectionId']);
    const wasConnected = entry.status === 'connected';
    connections.revoke(entry.id, Date.now());
    if (wasConnected) {
      ctx.events.emit('plugin.auth.revoked', {
        pluginId: process.pluginId,
        connectionId: entry.id,
        serviceId: entry.serviceId,
      });
    }
    return {};
  });
}
