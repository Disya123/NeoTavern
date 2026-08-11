/**
 * Capability broker (rev4 §B): the single authority that turns manifest
 * capability requests into grants, answers runtime `check` calls, and
 * revokes grants with fan-out to every interested party.
 *
 * Persistence lives in `packages/db` (plugin_capability_grants); this
 * module owns the policy:
 *   - a request is grantable only when the user consented to it — consent is
 *     recorded as the corresponding string in `grantedPermissions` (legacy
 *     flat names are aliased onto the v4 catalog by `parseCapability`);
 *   - revocation marks the row revoked, emits `plugin.capability.revoked` on
 *     the app event bus (SSE → web host → kernel session → plugin) and
 *     returns the revision the broker observed.
 *
 * The broker never executes plugin code and never touches the sandbox; it
 * only decides. Enforcement points (backend host, web runtime, this module's
 * `check`) all consult the same repository so server and browser agree.
 */
import { kernel, type PluginEventBus } from '@neotavern/plugin-sdk';
import type { CapabilityGrantEntry, CapabilityGrantRepository } from '@neotavern/db';

/** Bus payload of `plugin.capability.revoked` (relayed over SSE). */
export interface CapabilityRevokedPayload {
  pluginId: string;
  name: string;
  revision: number;
}

export const CAPABILITY_REVOKED_EVENT = 'plugin.capability.revoked';

export interface CapabilityBroker {
  /**
   * Issue grants for every consented manifest request. Requests the user did
   * not consent to are simply not granted (ТЗ §7.4); unknown request strings
   * are skipped. An already-active grant is returned as-is (idempotent
   * re-activation must not churn revisions).
   */
  grantConsented(
    pluginId: string,
    manifest: {
      requiredCapabilities?: readonly kernel.CapabilityRequest[];
      optionalCapabilities?: readonly kernel.CapabilityRequest[];
    },
    grantedPermissions: readonly string[],
  ): kernel.CapabilityGrant[];
  /** Active, non-expired grants as kernel `CapabilityGrant` values. */
  activeGrants(pluginId: string): kernel.CapabilityGrant[];
  /**
   * Issue a capability the user just approved at runtime (rev4 §B2
   * `capabilities.request`). Unlike {@link grantConsented} there is no
   * manifest or `grantedPermissions` check: the consent itself happened in
   * the host consent UI and is persisted as the grant row. Names outside the
   * catalog (or `legacy.trusted`) return `null`. An already-active grant is
   * returned as-is (idempotent — repeated requests must not churn revisions).
   */
  grantRuntime(pluginId: string, request: kernel.CapabilityRequest): kernel.CapabilityGrant | null;
  /** Runtime check used by enforcement points (rev4 §B2). */
  check(pluginId: string, request: kernel.CapabilityRequest): boolean;
  /** Revoke one grant; returns the observed revision, or null when absent. */
  revoke(pluginId: string, name: string): number | null;
  /** Revoke everything the plugin holds (disable / uninstall). */
  revokeAll(pluginId: string): number;
}

export function createCapabilityBroker(
  grants: CapabilityGrantRepository,
  events: PluginEventBus,
): CapabilityBroker {
  const toGrant = (entry: CapabilityGrantEntry): kernel.CapabilityGrant => ({
    name: entry.name,
    scope: entry.scope as kernel.CapabilityGrant['scope'],
    revision: entry.revision,
    grantedAt: entry.grantedAt,
  });

  return {
    grantConsented(pluginId, manifest, grantedPermissions) {
      const requests = [
        ...(manifest.requiredCapabilities ?? []),
        ...(manifest.optionalCapabilities ?? []),
      ];
      const now = Date.now();
      const issued: kernel.CapabilityGrant[] = [];
      for (const request of requests) {
        const existing = grants.get(pluginId, request.name);
        if (
          existing &&
          existing.revokedAt === null &&
          (existing.expiresAt === null || existing.expiresAt > now)
        ) {
          issued.push(toGrant(existing));
          continue;
        }
        const consent = consentFor(request, grantedPermissions);
        if (!consent) continue; // ungranted requests are simply never issued (ТЗ §7.4)
        const entry = grants.grant({
          pluginId,
          name: request.name,
          scope: (consent.scope ?? {}) as Record<string, unknown>,
        });
        issued.push(toGrant(entry));
      }
      return issued;
    },

    activeGrants(pluginId) {
      return grants.listActive(pluginId, Date.now()).map(toGrant);
    },

    grantRuntime(pluginId, request) {
      const parsed = kernel.parseCapability(request.name);
      if (!parsed) return null; // not in the catalog (includes legacy.trusted)
      const explicitScope =
        typeof request.scope === 'string' ||
        (typeof request.scope === 'object' && request.scope !== null)
          ? kernel.parseCapabilityScope(request.scope)
          : undefined;
      const scope = explicitScope ?? parsed.scope;
      const now = Date.now();
      const existing = grants.get(pluginId, parsed.name);
      if (
        existing &&
        existing.revokedAt === null &&
        (existing.expiresAt === null || existing.expiresAt > now)
      ) {
        return toGrant(existing);
      }
      const entry = grants.grant({
        pluginId,
        name: parsed.name,
        scope: (scope ?? {}) as Record<string, unknown>,
      });
      return toGrant(entry);
    },

    check(pluginId, request) {
      const entry = grants.get(pluginId, request.name);
      if (!entry || entry.revokedAt !== null) return false;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return false;
      return kernel.grantSatisfies(toGrant(entry), request);
    },

    revoke(pluginId, name) {
      const entry = grants.get(pluginId, name);
      if (!entry || entry.revokedAt !== null) return null;
      grants.revoke(pluginId, name, Date.now());
      const revoked = grants.get(pluginId, name);
      const revision = revoked?.revision ?? entry.revision;
      events.emit(CAPABILITY_REVOKED_EVENT, { pluginId, name, revision });
      return revision;
    },

    revokeAll(pluginId) {
      const active = grants.listActive(pluginId, Date.now());
      const count = grants.revokeAll(pluginId, Date.now());
      for (const entry of active) {
        events.emit(CAPABILITY_REVOKED_EVENT, {
          pluginId,
          name: entry.name,
          revision: entry.revision,
        });
      }
      return count;
    },
  };
}

/**
 * Match a manifest request against the user's consented permission strings.
 * Exact name match wins; otherwise a legacy flat string whose parsed
 * capability satisfies the request (name + scope cover) counts as consent.
 */
function consentFor(
  request: kernel.CapabilityRequest,
  grantedPermissions: readonly string[],
): kernel.CapabilityRequest | null {
  for (const raw of grantedPermissions) {
    if (raw === request.name) return request;
    const parsed = kernel.parseCapability(raw);
    if (parsed) {
      const scope =
        typeof parsed.scope === 'string' ? kernel.parseCapabilityScope(parsed.scope) : parsed.scope;
      if (kernel.grantSatisfies({ name: parsed.name, scope, revision: 0, grantedAt: 0 }, request)) {
        return parsed;
      }
    }
  }
  return null;
}
