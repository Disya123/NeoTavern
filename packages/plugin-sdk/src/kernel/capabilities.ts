/**
 * Plugin SDK revision-4 kernel: capability model.
 *
 * Permissions are not a flat string list anymore (rev4 §B1): a plugin requests
 * named capabilities with a scope, the host grants them explicitly, and grants
 * can be revoked at runtime (rev4 §B2). Trust is a matrix of runtimes, not a
 * ladder (rev4 §B3) — `legacy.trusted` is a separate admin-only extension
 * type, never a permission a normal consent dialog can grant.
 */

/** Scope descriptors a capability grant can carry (rev4 §B1 granularity). */
export type CapabilityScope =
  | { kind: 'current-chat' }
  | { kind: 'selected-chats'; chatIds: string[] }
  | { kind: 'chat'; chatId: string }
  | { kind: 'all' }
  | { kind: 'user' }
  | { kind: 'workspace'; workspaceId?: string }
  | { kind: 'installation' }
  | { kind: 'origins'; origins: string[] }
  | { kind: 'custom'; params: Record<string, unknown> };

/** Manifest capability request (rev4 §B1). */
export interface CapabilityRequest {
  name: string;
  scope?: string | CapabilityScope;
}

/** A granted capability as returned in the host handshake (rev4 §A1). */
export interface CapabilityGrant {
  name: string;
  scope?: CapabilityScope;
  /** Monotonic grant revision; revocation bumps it. */
  revision: number;
  grantedAt: number;
}

/**
 * The full capability catalog (rev4 §B1 granularity list). Names are stable
 * contract; the host validates manifest requests against this set plus the
 * `network:` / `files:` scoped families carried over from SDK v2.
 */
export const CAPABILITY_NAMES = [
  // Chat data
  'chats.read.current',
  'chats.read.selected',
  'chats.read.all',
  'chats.list',
  'chats.search',
  'chats.write.plugin',
  'chats.write.assistant',
  'chats.edit.own',
  'chats.delete.own',
  'chats.draft',
  // Storage
  'storage.installation',
  'storage.user',
  'storage.workspace',
  'storage.chat',
  'storage.blobs',
  // UI
  'ui.panel',
  'ui.overlay',
  'ui.overlay.full',
  'ui.modal',
  'ui.commands',
  'ui.surfaces',
  'ui.global-shortcuts',
  'ui.messageBlock',
  'ui.notification',
  // Compute
  'compute.worker',
  'compute.backend',
  'jobs.background',
  // Network and integrations
  'network.domains',
  'auth.connections',
  'secrets.use',
  // Host-mediated actions (rev4 §K4)
  'files.pick',
  'files.save',
  'clipboard.read',
  'clipboard.write',
  'notifications.show',
  'audio.play',
  'camera.request',
  'microphone.request',
  'system.openExternal',
  // Cross-plugin services
  'services.provide',
  'services.connect',
  // vNext Node runtime catalog (ТЗ v3.2 §12, apiVersion 3 manifests)
  'storage.kv',
  'files.plugin',
  'files.system',
  'network.http',
  'network.websocket',
  'network.tcp',
  'network.udp',
  'network.listen',
  'network.dns',
  'network.local',
  'network.private',
  'network.metadata',
  'network.listen.public',
  'process.spawn',
  'process.exec',
  'process.signal',
  'system.env.read',
  'system.info',
  'system.unrestricted',
  'secrets.manageOwn',
  'secrets.reveal',
  'models.list',
  'models.invoke',
  'models.stream',
  'providers.read',
  'providers.register',
  'providers.configure',
  'database.core.read',
  'database.core.write',
  'jobs.longRunning',
  'scheduler.register',
  'settings.read',
  'settings.write',
  'characters.read',
  'characters.write',
  'lorebook.read',
  'lorebook.write',
  'chats.read',
  'chats.write',
  'diagnostics.own',
  'server.routes',
  'server.middleware',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/**
 * Parse a permission/capability string from a manifest into a capability
 * request. Supports:
 *   - plain names from the catalog (`ui.panel`)
 *   - `network:<origin>` and `network:*` families (SDK v2 compat)
 *   - `files:plugin` / `files:user-selected` (SDK v2 compat)
 */
export function parseCapability(raw: string): CapabilityRequest | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 128) return null;
  if (value.startsWith('network:')) {
    const scope = value.slice('network:'.length);
    if (scope === '*') return { name: 'network.domains', scope: { kind: 'all' } };
    if (!isValidOrigin(scope) && !/^[a-z0-9.-]+$/i.test(scope)) return null;
    const origin = scope.includes('://') ? scope : `https://${scope}`;
    return { name: 'network.domains', scope: { kind: 'origins', origins: [origin] } };
  }
  if (value === 'files:plugin') return { name: 'storage.installation' };
  if (value === 'files:user-selected') return { name: 'files.pick' };
  if (value === 'legacy.trusted') return null; // admin-only extension type, never manifest-grantable
  if ((CAPABILITY_NAMES as readonly string[]).includes(value)) return { name: value };
  // SDK v2 names map onto the v4 catalog so existing packages keep working.
  const legacy = LEGACY_ALIAS[value];
  return legacy ? { name: legacy } : null;
}

const LEGACY_ALIAS: Record<string, CapabilityName> = {
  'chat.read': 'chats.read.current',
  'chat.write': 'chats.write.plugin',
  'characters.read': 'chats.read.current',
  'characters.write': 'chats.write.plugin',
  'lorebook.read': 'chats.read.current',
  'lorebook.write': 'chats.write.plugin',
  'prompt.inspect': 'chats.read.current',
  'prompt.modify': 'chats.write.plugin',
  'providers.register': 'compute.backend',
  'ui.toolbar': 'ui.commands',
  'ui.sidebar': 'ui.panel',
  'ui.messageActions': 'ui.commands',
  'ui.shell': 'ui.panel',
  'clipboard.read': 'clipboard.read',
  'clipboard.write': 'clipboard.write',
  notifications: 'notifications.show',
  'server.routes': 'compute.backend',
};

function isValidOrigin(scope: string): boolean {
  try {
    const url = new URL(scope);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Normalize a manifest scope shorthand into a CapabilityScope. */
export function parseCapabilityScope(value: unknown): CapabilityScope | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    switch (value) {
      case 'current-chat':
        return { kind: 'current-chat' };
      case 'selected-chats':
        return { kind: 'selected-chats', chatIds: [] };
      case 'all':
        return { kind: 'all' };
      case 'user':
        return { kind: 'user' };
      case 'installation':
        return { kind: 'installation' };
      default:
        return undefined;
    }
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string') return undefined;
  switch (kind) {
    case 'current-chat':
      return { kind: 'current-chat' };
    case 'selected-chats': {
      const chatIds = Array.isArray(record['chatIds'])
        ? record['chatIds'].filter((id): id is string => typeof id === 'string')
        : [];
      return { kind: 'selected-chats', chatIds };
    }
    case 'chat':
      return typeof record['chatId'] === 'string'
        ? { kind: 'chat', chatId: record['chatId'] }
        : undefined;
    case 'all':
      return { kind: 'all' };
    case 'user':
      return { kind: 'user' };
    case 'workspace':
      return {
        kind: 'workspace',
        ...(typeof record['workspaceId'] === 'string'
          ? { workspaceId: record['workspaceId'] }
          : {}),
      };
    case 'installation':
      return { kind: 'installation' };
    case 'origins': {
      if (!Array.isArray(record['origins'])) return undefined;
      const origins = record['origins'].filter((o): o is string => typeof o === 'string');
      return origins.length > 0 ? { kind: 'origins', origins } : undefined;
    }
    case 'custom':
      return typeof record['params'] === 'object' && record['params'] !== null
        ? { kind: 'custom', params: record['params'] as Record<string, unknown> }
        : undefined;
    default:
      return undefined;
  }
}

/** Whether a grant satisfies a capability request (name match + scope cover). */
export function grantSatisfies(grant: CapabilityGrant, request: CapabilityRequest): boolean {
  if (grant.name !== request.name) return false;
  const want =
    typeof request.scope === 'string' ? parseCapabilityScope(request.scope) : request.scope;
  if (!want) return true;
  const has = grant.scope;
  if (!has) return false;
  if (has.kind === 'all') return true;
  if (has.kind !== want.kind) return false;
  if (has.kind === 'chat' && want.kind === 'chat') return has.chatId === want.chatId;
  if (has.kind === 'selected-chats' && want.kind === 'chat') {
    return has.chatIds.includes(want.chatId);
  }
  if (has.kind === 'origins' && want.kind === 'origins') {
    return want.origins.every((origin) => has.origins.includes(origin));
  }
  return true;
}

/** Compute capability diffs between two manifests (consent re-prompt, rev4 §B2). */
export function diffCapabilities(
  previous: readonly CapabilityRequest[],
  next: readonly CapabilityRequest[],
): { added: CapabilityRequest[]; removed: CapabilityRequest[] } {
  const key = (request: CapabilityRequest): string =>
    `${request.name}:${typeof request.scope === 'string' ? request.scope : JSON.stringify(request.scope ?? null)}`;
  const prevKeys = new Map(previous.map((request) => [key(request), request]));
  const nextKeys = new Map(next.map((request) => [key(request), request]));
  const added = [...nextKeys.entries()].filter(([k]) => !prevKeys.has(k)).map(([, v]) => v);
  const removed = [...prevKeys.entries()].filter(([k]) => !nextKeys.has(k)).map(([, v]) => v);
  return { added, removed };
}
