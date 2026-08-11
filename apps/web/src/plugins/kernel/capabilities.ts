/**
 * Kernel slice: capability introspection and runtime grants (rev4 §B2).
 *
 * - `capabilities.list` exposes the plugin's currently granted capability
 *   names so sandboxed code can adapt before calling (and react to
 *   `onRevoked` afterwards). Grants are the plugin's own; listing them leaks
 *   nothing about other plugins, so the method requires an active session but
 *   no extra capability.
 * - `capabilities.request` runs the consent round-trip: the host shows the
 *   consent dialog, POSTs the approved grant to the server and publishes it
 *   into the live frame grant list. Denied/timeout requests reject with
 *   `CAPABILITY_DENIED`; an unreachable backend maps to
 *   `BACKEND_UNAVAILABLE`.
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

/** Listing cap: a grant list beyond this is unusable in a consent UI anyway. */
const MAX_LISTED_GRANTS = 64;

function invalidRequest(reason: string): kernel.KernelError {
  return new kernel.KernelError(kernel.KernelErrorCode.VALIDATION_FAILED, {
    details: { reason },
  });
}

export function attachCapabilities(ctx: KernelHostContext): void {
  ctx.session.handle('capabilities.list', () => {
    const granted = ctx.frame.plugin.grantedCapabilities;
    return { grants: Array.isArray(granted) ? granted.slice(0, MAX_LISTED_GRANTS) : [] };
  });

  ctx.session.handle('capabilities.request', async (requestContext) => {
    const request =
      requestContext.params &&
      typeof requestContext.params === 'object' &&
      !Array.isArray(requestContext.params)
        ? (requestContext.params as Record<string, unknown>)
        : null;
    const name = request && typeof request['name'] === 'string' ? request['name'] : '';
    if (name.length === 0 || name.length > 128) {
      throw invalidRequest('capability-name-required');
    }
    const scope = request && 'scope' in request ? request['scope'] : undefined;
    if (scope !== undefined && typeof scope !== 'string' && !isPlainObject(scope)) {
      throw invalidRequest('invalid-scope');
    }
    const grant = await ctx.runtime.requestCapabilityConsent(
      ctx.frame,
      scope === undefined ? { name } : { name, scope: scope as kernel.CapabilityRequest['scope'] },
    );
    return { grant };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
