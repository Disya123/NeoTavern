/**
 * Shared server-side OAuth connection resolution (rev4 §K5, api.auth).
 *
 * The single place where a stored access token is turned into an
 * Authorization header. Used by the backend RPC `network.fetch`
 * (backendRpcExtensions.ts) and the web proxy route
 * `POST /api/v2/plugins/:id/auth/fetch` (pluginAuth.ts). The token payload
 * never leaves this module.
 */
import { AppError, ErrorCodes } from '@neotavern/shared';
import type { AppContext } from '../types.js';
import type { CapabilityBroker } from './capabilityBroker.js';

export function requireAuthCapability(broker: CapabilityBroker, pluginId: string): void {
  if (!broker.check(pluginId, { name: 'auth.connections' })) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
      params: { pluginId, permission: 'auth.connections' },
    });
  }
}

/**
 * Resolve an OAuth connection id into an Authorization header value.
 * - revoked connections fail (token already deleted server-side);
 * - pending/absent connections fail with AUTH_NOT_CONNECTED;
 * - expired tokens flip the connection to `expired`, emit the event and
 *   fail with AUTH_EXPIRED. v1 does not refresh automatically.
 */
export async function resolveConnectionAuthorization(
  ctx: AppContext,
  broker: CapabilityBroker,
  pluginId: string,
  connectionId: unknown,
): Promise<string> {
  requireAuthCapability(broker, pluginId);
  if (typeof connectionId !== 'string' || connectionId.length === 0 || connectionId.length > 64) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'AUTH_CONNECTION_ID_INVALID' },
    });
  }
  const entry = ctx.database.repos.authConnections.getById(pluginId, connectionId);
  if (!entry) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'AUTH_CONNECTION_NOT_FOUND' },
    });
  }
  if (entry.status === 'revoked') {
    throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'AUTH_REVOKED' } });
  }
  if (entry.status !== 'connected' || entry.token === null) {
    throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'AUTH_NOT_CONNECTED' } });
  }
  const payload = entry.token as {
    accessToken: string;
    tokenType?: string;
    expiresAt?: number | null;
  };
  if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) {
    throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'AUTH_TOKEN_INVALID' } });
  }
  if (typeof payload.expiresAt === 'number' && payload.expiresAt <= Date.now()) {
    if (ctx.database.repos.authConnections.markExpired(entry.id, Date.now())) {
      ctx.events.emit('plugin.auth.expired', {
        pluginId,
        connectionId: entry.id,
        serviceId: entry.serviceId,
      });
    }
    throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'AUTH_EXPIRED' } });
  }
  const tokenType =
    typeof payload.tokenType === 'string' && payload.tokenType.length > 0
      ? payload.tokenType
      : 'Bearer';
  return `${tokenType} ${payload.accessToken}`;
}
