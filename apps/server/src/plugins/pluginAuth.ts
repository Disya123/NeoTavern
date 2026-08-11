/**
 * Plugin OAuth connections (rev4 §K5, api.auth): the server-side PKCE dance.
 *
 * Security contract:
 *   - Public OAuth clients only (PKCE, no clientSecret — sandbox code cannot
 *     hold one).
 *   - The access token NEVER leaves this module: the sandbox gets metadata,
 *     authenticated traffic goes through the `network.fetch` proxy, which
 *     resolves the stored token and injects the Authorization header.
 *   - `state` is one-shot: it is cleared on a successful callback, so a
 *     replayed callback fails with STATE_EXPIRED.
 *   - Redirect target and token exchange are HTTPS-only, enforced by the
 *     manifest validator (isHttpsUrl); the token exchange refuses redirects.
 */
import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import {
  PluginAuthCallbackQuerySchema,
  PluginAuthConnectRequestSchema,
  PluginAuthConnectResultSchema,
  PluginAuthConnectionsResponseSchema,
  PluginAuthFetchRequestSchema,
  PluginAuthFetchResultSchema,
  PluginAuthRevokeRequestSchema,
  PluginAuthRevokeResultSchema,
  PluginIdSchema,
  type PluginAuthConnectResult,
  type PluginAuthConnectionWire,
  type PluginAuthConnectionsResponse,
  type PluginAuthFetchResult,
  type PluginAuthRevokeResult,
} from '@neotavern/contracts';
import type { AuthConnectionEntry, PluginRepository } from '@neotavern/db';
import { AppError, ErrorCodes, randomToken } from '@neotavern/shared';
import { validateManifest, type PluginManifest } from '@neotavern/plugin-sdk';
import type { AppContext, TypedApp } from '../types.js';
import type { CapabilityBroker } from '../plugin/capabilityBroker.js';
import {
  requireAuthCapability,
  resolveConnectionAuthorization,
} from '../plugin/authConnections.js';

const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;
const TOKEN_EXCHANGE_MAX_BYTES = 256 * 1024;
/** One-time state length: 32 bytes hex (64 chars, URL-safe). */
const STATE_BYTES = 32;
/** PKCE code_verifier: 32 bytes hex (64 chars, within 43..128). */
const VERIFIER_BYTES = 32;
const AUTH_FETCH_TIMEOUT_MS = 15_000;
const AUTH_FETCH_MAX_BYTES = 1024 * 1024;
const AUTH_FETCH_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

function toWire(entry: AuthConnectionEntry): PluginAuthConnectionWire {
  return {
    connectionId: entry.id,
    serviceId: entry.serviceId,
    serviceName: entry.serviceName,
    scopes: entry.scopes,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** The redirect_uri registered with the IdP; only the same-origin callback. */
function callbackUri(ctx: AppContext, pluginId: string): string {
  return `${ctx.config.publicOrigin}/api/v2/plugins/${encodeURIComponent(pluginId)}/auth/callback`;
}

function findAuthClient(manifest: PluginManifest, serviceId: string) {
  const client = manifest.authClients?.find((item) => item.serviceId === serviceId);
  if (!client) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_INVALID,
      params: { reason: 'auth-service-not-declared', serviceId },
    });
  }
  return client;
}

function buildAuthorizationUrl(input: {
  client: { authorizationUrl: string; clientId: string; scopes: string[] };
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.client.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.client.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.client.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function resultRedirect(ctx: AppContext, params: URLSearchParams): { redirect: string } {
  const target = new URL(`${ctx.config.publicOrigin}/`);
  target.hash = `/plugin-auth-result?${params.toString()}`;
  return { redirect: target.toString() };
}

interface TokenPayload {
  accessToken: string;
  tokenType: string;
  expiresAt: number | null;
  refreshToken?: string;
}

/** Parse the IdP token response; JSON and form-encoded bodies are accepted. */
function parseTokenResponse(text: string): TokenPayload {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    const params = new URLSearchParams(text);
    data = Object.fromEntries(params.entries());
  }
  const accessToken = data['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'TOKEN_RESPONSE_INVALID' },
    });
  }
  const expiresIn = data['expires_in'];
  return {
    accessToken,
    tokenType:
      typeof data['token_type'] === 'string' && data['token_type'].length > 0
        ? data['token_type']
        : 'Bearer',
    expiresAt:
      typeof expiresIn === 'number' && Number.isFinite(expiresIn)
        ? Date.now() + expiresIn * 1000
        : null,
    ...(typeof data['refresh_token'] === 'string' ? { refreshToken: data['refresh_token'] } : {}),
  };
}

/** Exchange the authorization code for a token (PKCE, redirect refused). */
async function exchangeCode(input: {
  tokenUrl: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenPayload> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  });
  let response: Response;
  try {
    response = await fetch(input.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new AppError({
      code: timedOut ? ErrorCodes.TIMEOUT : ErrorCodes.BAD_REQUEST,
      params: { reason: timedOut ? 'TOKEN_EXCHANGE_TIMEOUT' : 'TOKEN_EXCHANGE_FAILED' },
      cause: error,
    });
  }
  const text = await readBoundedBody(response, TOKEN_EXCHANGE_MAX_BYTES);
  if (!response.ok) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'TOKEN_EXCHANGE_REJECTED', status: response.status },
    });
  }
  return parseTokenResponse(text);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError({
          code: ErrorCodes.FILE_TOO_LARGE,
          params: { limitBytes: maxBytes },
        });
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Register `/api/v2/plugins/:id/auth/*` routes. `safeMode` is read live so a
 * mid-request safe-mode toggle is honored; `repo` is the plugin registry.
 */
export function registerPluginAuthRoutes(
  app: TypedApp,
  ctx: AppContext,
  broker: CapabilityBroker,
  repo: PluginRepository,
  safeMode: () => boolean,
): void {
  const connections = ctx.database.repos.authConnections;

  app.get(
    '/api/v2/plugins/:id/auth/connections',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        response: { 200: PluginAuthConnectionsResponseSchema },
      },
    },
    async (request): Promise<PluginAuthConnectionsResponse> => {
      const pluginId = request.params.id;
      const entry = repo.getById(pluginId);
      if (!entry || !entry.enabled || safeMode()) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId },
        });
      }
      requireAuthCapability(broker, pluginId);
      return { items: connections.list(pluginId).map(toWire) };
    },
  );

  app.post(
    '/api/v2/plugins/:id/auth/connect',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        body: PluginAuthConnectRequestSchema,
        response: { 200: PluginAuthConnectResultSchema },
      },
    },
    async (request): Promise<PluginAuthConnectResult> => {
      const pluginId = request.params.id;
      const entry = repo.getById(pluginId);
      if (!entry || !entry.enabled || safeMode()) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId },
        });
      }
      requireAuthCapability(broker, pluginId);
      const manifest = validateManifestStored(entry.manifest);
      const client = findAuthClient(manifest, request.body.serviceId);
      const scopes = request.body.scopes ?? client.scopes;
      const existing = connections.getActiveByService(pluginId, client.serviceId);
      if (existing) {
        return existing.status === 'connected'
          ? { connectionId: existing.id, status: 'connected', authorizationUrl: null }
          : pendingResult(existing, ctx, pluginId, client);
      }
      const state = randomToken(STATE_BYTES);
      const codeVerifier = randomToken(VERIFIER_BYTES);
      const created = connections.createPending({
        pluginId,
        serviceId: client.serviceId,
        serviceName: client.name,
        scopes,
        state,
        codeVerifier,
      });
      return pendingResult(created, ctx, pluginId, client);
    },
  );

  function pendingResult(
    connection: AuthConnectionEntry,
    ctxArg: AppContext,
    pluginId: string,
    client: { authorizationUrl: string; clientId: string },
  ): PluginAuthConnectResult {
    const challenge = pkceChallenge(connection.codeVerifier);
    return {
      connectionId: connection.id,
      status: 'pending',
      authorizationUrl: buildAuthorizationUrl({
        client: {
          authorizationUrl: client.authorizationUrl,
          clientId: client.clientId,
          scopes: connection.scopes,
        },
        redirectUri: callbackUri(ctxArg, pluginId),
        state: connection.state,
        codeChallenge: challenge,
      }),
    };
  }

  app.post(
    '/api/v2/plugins/:id/auth/revoke',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        body: PluginAuthRevokeRequestSchema,
        response: { 200: PluginAuthRevokeResultSchema },
      },
    },
    async (request): Promise<PluginAuthRevokeResult> => {
      const pluginId = request.params.id;
      const entry = repo.getById(pluginId);
      if (!entry || !entry.enabled || safeMode()) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId },
        });
      }
      requireAuthCapability(broker, pluginId);
      const connection = connections.getById(pluginId, request.body.connectionId);
      if (!connection) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'AUTH_CONNECTION_NOT_FOUND' },
        });
      }
      if (connection.status === 'connected') {
        connections.revoke(connection.id, Date.now());
        ctx.events.emit('plugin.auth.revoked', {
          pluginId,
          connectionId: connection.id,
          serviceId: connection.serviceId,
        });
      } else {
        connections.revoke(connection.id, Date.now());
      }
      return { ok: true };
    },
  );

  /**
   * Authenticated fetch proxy for web sandboxes (rev4 §K5): resolves the
   * connection token server-side, injects Authorization, enforces the
   * network allowlist (granted permissions `network:*`/`network:<host>` or
   * the `network.domains` capability) and refuses redirects. Tokens never
   * leave this module.
   */
  app.post(
    '/api/v2/plugins/:id/auth/fetch',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        body: PluginAuthFetchRequestSchema,
        response: { 200: PluginAuthFetchResultSchema },
      },
    },
    async (request): Promise<PluginAuthFetchResult> => {
      const pluginId = request.params.id;
      const entry = repo.getById(pluginId);
      if (!entry || !entry.enabled || safeMode()) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId },
        });
      }
      requireAuthCapability(broker, pluginId);
      let parsed: URL;
      try {
        parsed = new URL(request.body.url);
      } catch {
        throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'URL_INVALID' } });
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'URL_SCHEME_NOT_ALLOWED' },
        });
      }
      const hostname = parsed.hostname.toLowerCase();
      const allowed =
        entry.grantedPermissions.includes('network:*') ||
        entry.grantedPermissions.includes(`network:${hostname}`) ||
        broker.check(pluginId, { name: 'network.domains', scope: { kind: 'all' } }) ||
        broker.check(pluginId, {
          name: 'network.domains',
          scope: { kind: 'origins', origins: [parsed.origin] },
        });
      if (!allowed) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
          params: { pluginId, permission: `network:${hostname}` },
        });
      }
      const connection = connections.getById(pluginId, request.body.connectionId);
      if (!connection) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'AUTH_CONNECTION_NOT_FOUND' },
        });
      }
      const authorization = await resolveConnectionAuthorization(
        ctx,
        broker,
        pluginId,
        request.body.connectionId,
      );
      const method = request.body.method ?? 'GET';
      if (!AUTH_FETCH_METHODS.has(method)) {
        throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'METHOD_INVALID' } });
      }
      const headers: Record<string, string> = { ...request.body.headers };
      headers['Authorization'] = authorization;
      const body =
        typeof request.body.bodyText === 'string' &&
        Buffer.byteLength(request.body.bodyText) <= AUTH_FETCH_MAX_BYTES
          ? request.body.bodyText
          : undefined;
      let response: Response;
      try {
        response = await fetch(parsed, {
          method,
          headers,
          ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        throw new AppError({
          code: timedOut ? ErrorCodes.TIMEOUT : ErrorCodes.BAD_REQUEST,
          params: { reason: timedOut ? 'FETCH_TIMEOUT' : 'FETCH_FAILED', hostname },
          cause: error,
        });
      }
      const text = await readBoundedBody(response, AUTH_FETCH_MAX_BYTES);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      return { status: response.status, headers: responseHeaders, bodyText: text };
    },
  );

  /**
   * OAuth callback from the IdP. Called by the user's browser, NOT by the
   * sandbox — it does not require the plugin to be enabled (only the
   * one-shot `state` proves the flow), so a half-finished consent survives a
   * plugin restart. Always answers with a browser redirect.
   */
  app.get(
    '/api/v2/plugins/:id/auth/callback',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        querystring: PluginAuthCallbackQuerySchema,
      },
    },
    async (request, reply) => {
      const pluginId = request.params.id;
      const query = request.query;
      const state = query.state ?? '';
      const connection = state.length > 0 ? connections.getByState(state) : null;
      const fail = (reason: string, extra?: Record<string, string>): { redirect: string } =>
        resultRedirect(ctx, new URLSearchParams({ pluginId, status: 'error', reason, ...extra }));
      if (!connection || connection.pluginId !== pluginId)
        return reply.redirect(fail('STATE_EXPIRED').redirect);
      if (query.error)
        return reply.redirect(fail('DENIED', { serviceId: connection.serviceId }).redirect);
      const plugin = repo.getById(pluginId);
      if (!plugin || !plugin.enabled || safeMode()) {
        // Do not burn the state: the user can finish the flow after enabling.
        return reply.redirect(
          fail('PLUGIN_DISABLED', { serviceId: connection.serviceId }).redirect,
        );
      }
      if (typeof query.code !== 'string' || query.code.length === 0) {
        return reply.redirect(fail('CODE_MISSING', { serviceId: connection.serviceId }).redirect);
      }
      try {
        const manifest = validateManifestStored(plugin.manifest);
        const client = findAuthClient(manifest, connection.serviceId);
        const token = await exchangeCode({
          tokenUrl: client.tokenUrl,
          clientId: client.clientId,
          code: query.code,
          redirectUri: callbackUri(ctx, pluginId),
          codeVerifier: connection.codeVerifier,
        });
        const updated = connections.markConnected(connection.id, token);
        ctx.events.emit('plugin.auth.connected', {
          pluginId,
          connectionId: updated.id,
          serviceId: updated.serviceId,
        });
        return reply.redirect(
          resultRedirect(
            ctx,
            new URLSearchParams({
              pluginId,
              serviceId: updated.serviceId,
              status: 'connected',
            }),
          ).redirect,
        );
      } catch {
        return reply.redirect(
          fail('TOKEN_EXCHANGE_FAILED', { serviceId: connection.serviceId }).redirect,
        );
      }
    },
  );
}

function validateManifestStored(raw: unknown): PluginManifest {
  const result = validateManifest(raw);
  if (!result.ok) throw result.error;
  return result.value;
}
